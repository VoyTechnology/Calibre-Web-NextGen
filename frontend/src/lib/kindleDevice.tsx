/* The USB-connected Kindle, shared across the app.
 *
 * One KindleConnection is held for the whole session so the sidebar, the device page and every book
 * page can show what is on the Kindle without re-negotiating USB. A Kindle the browser has been
 * granted before is picked up on load with no prompt; the first time (and after "Eject") the user
 * clicks to connect, because the browser only shows its device chooser for a user gesture.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { apiPost, resourceUrl } from './api';
import {
  AMAZON_VENDOR_ID, KindleConnection, isWebUsbSupported, pickKindle,
  type DeviceFile, type SendPhase, type UsbDeviceLike,
} from './kindleUsb';

export type DeviceStatus = 'unsupported' | 'none' | 'connecting' | 'connected' | 'ejected' | 'error';

export interface DeviceBook {
  id: number;
  title: string;
  authors: string[];
  /** null when the library book has no cover */
  cover_url: string | null;
}

/** A book file on the Kindle, with the library book it is when one could be identified. */
export interface DeviceEntry extends DeviceFile {
  book: DeviceBook | null;
}

export interface KindleSendResult {
  format: string;
  converted: boolean;
}

export interface KindleDeviceValue {
  status: DeviceStatus;
  /** Device name as the Kindle reports it, e.g. "Kindle Paperwhite". */
  name: string;
  entries: DeviceEntry[];
  space: { capacity: number; free: number } | null;
  error: string | null;
  /** Text for what a running send/refresh is doing, or null when idle. */
  busy: string | null;
  connect: () => Promise<void>;
  eject: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Prepare (convert if needed), download and push one book. Connects first when needed. */
  send: (bookId: number, onPhase?: (phase: string) => void) => Promise<KindleSendResult>;
  /** The Kindle's copy of a library book, or undefined. */
  onDevice: (bookId: number) => DeviceEntry | undefined;
}

const EJECTED_KEY = 'cwng:kindle-ejected';

const noop = async () => undefined;
const IDLE: KindleDeviceValue = {
  status: 'unsupported', name: '', entries: [], space: null, error: null, busy: null,
  connect: noop, eject: noop, refresh: noop,
  send: async () => { throw new Error('Kindle USB is not available.'); },
  onDevice: () => undefined,
};

const KindleDeviceContext = createContext<KindleDeviceValue>(IDLE);

export function useKindleDevice(): KindleDeviceValue {
  return useContext(KindleDeviceContext);
}

/** Message worth showing for a USB failure, or null for the user closing the device chooser. */
export function describeUsbError(err: unknown): string | null {
  if (err instanceof DOMException && err.name === 'NotFoundError') return null;
  const message = err instanceof Error ? err.message : String(err);
  if (/claim|access denied|busy|in use/i.test(message)) {
    return 'Another program (Calibre, Android File Transfer, OpenMTP) may be using the Kindle. '
      + 'Close it, then unplug and replug the Kindle.';
  }
  return message;
}

function readEjected(): boolean {
  try { return sessionStorage.getItem(EJECTED_KEY) === '1'; } catch { return false; }
}
function writeEjected(on: boolean) {
  try {
    if (on) sessionStorage.setItem(EJECTED_KEY, '1'); else sessionStorage.removeItem(EJECTED_KEY);
  } catch { /* private mode: the flag just does not survive a reload */ }
}

interface UsbEvents {
  addEventListener(type: 'connect' | 'disconnect', cb: (e: { device: UsbDeviceLike }) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', cb: (e: { device: UsbDeviceLike }) => void): void;
  getDevices(): Promise<UsbDeviceLike[]>;
}

export function KindleDeviceProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const supported = enabled && isWebUsbSupported();
  const [status, setStatus] = useState<DeviceStatus>(supported ? 'none' : 'unsupported');
  const [name, setName] = useState('');
  const [entries, setEntries] = useState<DeviceEntry[]>([]);
  const [space, setSpace] = useState<KindleDeviceValue['space']>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const connection = useRef<KindleConnection | null>(null);
  const attaching = useRef(false);

  const load = useCallback(async (conn: KindleConnection) => {
    const files = await conn.listBooks();
    let matched: Array<{ book: DeviceBook | null }> = [];
    if (files.length > 0) {
      const res = await apiPost<{ items: Array<{ book: DeviceBook | null }> }>(
        '/api/v1/kindle-usb/resolve', { files: files.map((f) => f.name) });
      matched = res.items;
    }
    setEntries(files.map((f, i) => ({ ...f, book: matched[i]?.book ?? null })));
    try { setSpace(await conn.space()); } catch { setSpace(null); }
  }, []);

  const drop = useCallback(async () => {
    const conn = connection.current;
    connection.current = null;
    if (conn) { try { await conn.close(); } catch { /* the device is already gone */ } }
    setEntries([]);
    setSpace(null);
  }, []);

  const attach = useCallback(async (device: UsbDeviceLike): Promise<KindleConnection> => {
    attaching.current = true;
    setStatus('connecting');
    setError(null);
    try {
      const conn = await KindleConnection.open(device);
      connection.current = conn;
      setName(conn.name);
      writeEjected(false);
      await load(conn);
      setStatus('connected');
      return conn;
    } catch (err) {
      await drop();
      const message = describeUsbError(err);
      setStatus(message === null ? 'none' : 'error');
      setError(message);
      throw err;
    } finally {
      attaching.current = false;
    }
  }, [drop, load]);

  const connect = useCallback(async () => {
    if (!supported || attaching.current) return;
    try {
      await attach(await pickKindle());
    } catch { /* attach() has recorded the outcome in state */ }
  }, [attach, supported]);

  const eject = useCallback(async () => {
    writeEjected(true);
    await drop();
    setStatus('ejected');
    setError(null);
  }, [drop]);

  const refresh = useCallback(async () => {
    const conn = connection.current;
    if (!conn) return;
    setBusy('Refreshing…');
    try { await load(conn); } catch (err) { setError(describeUsbError(err)); } finally { setBusy(null); }
  }, [load]);

  const send = useCallback(async (bookId: number, onPhase?: (phase: string) => void): Promise<KindleSendResult> => {
    // The chooser needs the click's user gesture, so connect before any slow work.
    let conn = connection.current;
    if (!conn) {
      onPhase?.('connecting');
      conn = await attach(await pickKindle());
    }
    setBusy('Sending…');
    try {
      onPhase?.('preparing');
      const plan = await apiPost<{ format: string; converted: boolean; filename: string; download_url: string }>(
        `/api/v1/books/${bookId}/kindle-usb`, {});
      onPhase?.('downloading');
      const response = await fetch(resourceUrl(plan.download_url), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await conn.send(plan.filename, bytes, (p: SendPhase) => onPhase?.(p));
      await load(conn);
      return { format: plan.format, converted: plan.converted };
    } finally {
      setBusy(null);
    }
  }, [attach, load]);

  // Pick up a Kindle the browser already has permission for, and follow plug/unplug.
  useEffect(() => {
    if (!supported) return;
    const usb = (navigator as unknown as { usb: UsbEvents }).usb;
    let cancelled = false;

    const adoptGranted = async () => {
      if (attaching.current || connection.current || readEjected()) return;
      const granted = (await usb.getDevices()).filter((d) => d.vendorId === AMAZON_VENDOR_ID);
      if (cancelled || granted.length !== 1) return;
      try { await attach(granted[0]); } catch { /* recorded in state */ }
    };
    void adoptGranted();

    const onConnect = (e: { device: UsbDeviceLike }) => {
      if (e.device.vendorId === AMAZON_VENDOR_ID) void adoptGranted();
    };
    const onDisconnect = (e: { device: UsbDeviceLike }) => {
      if (e.device.vendorId !== AMAZON_VENDOR_ID) return;
      writeEjected(false); // unplugged: the next plug-in is a fresh start
      void drop().then(() => { if (!cancelled) { setStatus('none'); setError(null); } });
    };
    usb.addEventListener('connect', onConnect);
    usb.addEventListener('disconnect', onDisconnect);
    return () => {
      cancelled = true;
      usb.removeEventListener('connect', onConnect);
      usb.removeEventListener('disconnect', onDisconnect);
    };
  }, [supported, attach, drop]);

  // Hand the Kindle back when the app unmounts (sign-out).
  useEffect(() => () => { void drop(); }, [drop]);

  const byBook = useMemo(() => {
    const map = new Map<number, DeviceEntry>();
    for (const e of entries) if (e.book && !map.has(e.book.id)) map.set(e.book.id, e);
    return map;
  }, [entries]);
  const onDevice = useCallback((bookId: number) => byBook.get(bookId), [byBook]);

  const value = useMemo<KindleDeviceValue>(() => ({
    status: supported ? status : 'unsupported',
    name, entries, space, error, busy, connect, eject, refresh, send, onDevice,
  }), [supported, status, name, entries, space, error, busy, connect, eject, refresh, send, onDevice]);

  return <KindleDeviceContext.Provider value={value}>{children}</KindleDeviceContext.Provider>;
}
