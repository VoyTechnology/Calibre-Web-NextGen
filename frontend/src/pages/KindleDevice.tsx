import { Link } from 'wouter';
import { RefreshCw, Unplug, Usb } from 'lucide-react';
import { useKindleDevice } from '../lib/kindleDevice';
import { useT } from '../lib/i18n';
import { useAnnouncer } from '../lib/a11y/announcer';
import { BookCover } from '../components/BookCover';
import { EmptyState } from '../components/EmptyState';
import { SpinnerCentered } from '../components/Spinner';
import styles from './KindleDevice.module.css';

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** The books on the USB-connected Kindle, with eject. The connection itself lives in the app shell, so this
 *  page only reads and acts on it. */
export function KindleDevice() {
  const t = useT();
  const announce = useAnnouncer();
  const device = useKindleDevice();

  if (device.status === 'unsupported') {
    return (
      <div className={styles.container}>
        <EmptyState icon={Usb} title={t('Kindle over USB')}
          message={t('This browser cannot talk to USB devices. Use Chrome or Edge on an https:// or localhost address, signed in with download permission.')} />
      </div>
    );
  }

  if (device.status === 'connecting') return <SpinnerCentered size={40} />;

  if (device.status !== 'connected') {
    const ejected = device.status === 'ejected';
    return (
      <div className={styles.container}>
        <EmptyState icon={Usb}
          title={ejected ? t('{name} ejected', { name: device.name || 'Kindle' }) : t('No Kindle connected')}
          message={device.error
            ?? (ejected
              ? t('It is safe to unplug. Connect again to see its books.')
              : t('Plug in your Kindle with a USB cable, unlock it, and connect it here.'))}>
          <button type="button" className={styles.primary} onClick={() => { void device.connect(); }}
            data-testid="device-connect">
            {ejected ? t('Reconnect') : t('Connect Kindle')}
          </button>
        </EmptyState>
      </div>
    );
  }

  const matched = device.entries.filter((e) => e.book);
  const others = device.entries.filter((e) => !e.book);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title} tabIndex={-1} data-testid="device-heading">{device.name}</h1>
          <p className={styles.sub}>
            {t('{count} books on the device', { count: device.entries.length })}
            {device.space ? ` · ${t('{free} free of {total}', {
              free: formatBytes(device.space.free), total: formatBytes(device.space.capacity) })}` : ''}
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => { void device.refresh(); }}
            disabled={device.busy !== null}>
            <RefreshCw size={15} aria-hidden="true" focusable={false} />
            {device.busy ?? t('Refresh')}
          </button>
          <button type="button" className={styles.primary} data-testid="device-eject"
            disabled={device.busy !== null}
            onClick={() => {
              void device.eject().then(() => announce(t('{name} ejected. It is safe to unplug.', { name: device.name })));
            }}>
            <Unplug size={15} aria-hidden="true" focusable={false} />
            {t('Eject')}
          </button>
        </div>
      </header>

      {device.error && <p className={styles.error} role="alert">{device.error}</p>}

      {device.entries.length === 0 ? (
        <EmptyState icon={Usb} message={t('There are no books on this Kindle yet. Send one from any book page.')} />
      ) : (
        <>
          {matched.length > 0 && (
            <ul className={styles.grid} role="list" data-testid="device-books">
              {matched.map((e) => (
                <li key={e.handle} className={styles.tile}>
                  <Link href={`/book/${e.book!.id}`} className={styles.tileLink}>
                    <div className={styles.cover}>
                      <BookCover coverUrl={e.book!.cover_url} title={e.book!.title} authors={e.book!.authors} />
                    </div>
                    <span className={styles.tileTitle}>{e.book!.title}</span>
                    <span className={styles.tileMeta}>{e.book!.authors.join(', ')}</span>
                    <span className={styles.tileMeta}>{e.ext.toUpperCase()} · {formatBytes(e.size)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {others.length > 0 && (
            <section className={styles.others} aria-labelledby="device-others">
              <h2 id="device-others" className={styles.subhead}>{t('Not in this library')}</h2>
              <ul role="list" className={styles.otherList}>
                {others.map((e) => (
                  <li key={e.handle} className={styles.otherRow}>
                    <span className={styles.otherName}>{e.folder ? `${e.folder}/` : ''}{e.name}</span>
                    <span className={styles.tileMeta}>{formatBytes(e.size)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
