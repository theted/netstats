/** One remote host, as the collector reports it. Rates are bytes per second. */
export interface Flow {
  /** Stable for as long as the host stays. Outside public mode it is the address itself. */
  id: string;
  /** Withheld in public mode. */
  ip?: string;
  lat: number;
  lon: number;
  city?: string;
  cc?: string;
  host?: string;
  proc?: string;
  proto: string;
  port: number;
  up: number;
  down: number;
  /** TCP handshake round trip in milliseconds, when one was seen. */
  rtt?: number;
}

export interface Snapshot {
  t: number;
  home: { lat: number; lon: number; city?: string };
  up: number;
  down: number;
  unlocated: number;
  /** The page is shown to strangers, so addresses are withheld. */
  public?: boolean;
  flows: Flow[];
  /** Sent about once a second, not with every snapshot. */
  stats?: Stats;
}

/**
 * Running totals since the collector started, as internal/stats reports them. Sizes are bytes, rates
 * bytes per second, times unix milliseconds.
 */
export interface Stats {
  since: number;
  /** When the machine booted, where known. */
  boot?: number;
  /** Sent to and received from internet hosts. */
  up: number;
  down: number;
  peakUp: number;
  peakDown: number;
  /** Distinct remote hosts, estimated. */
  hosts: number;
  /** The capture interface's own counters since boot, LAN traffic included. Linux only. */
  iface?: { name: string; up: number; down: number };
  /** The leading countries by traffic and by hosts, in no particular order. */
  countries: { cc: string; bytes: number; hosts: number }[];
  countryCount: number;
  /** The busiest services, by traffic. */
  services: { proto: string; port: number; bytes: number }[];
  farthest?: { city?: string; cc?: string; km: number };
}

export type Status = 'connecting' | 'live' | 'lost' | 'demo';

/**
 * Follows the collector's event stream. EventSource reconnects by itself after a drop. The stream is
 * closed while the tab is hidden, so a forgotten tab doesn't keep downloading snapshots nobody sees.
 */
export function connect(onSnapshot: (s: Snapshot) => void, onStatus: (s: Status) => void): () => void {
  let es: EventSource | null = null;
  const open = () => {
    if (es) return;
    onStatus('connecting');
    es = new EventSource('/events');
    es.onmessage = (e) => {
      onStatus('live');
      onSnapshot(JSON.parse(e.data) as Snapshot);
    };
    es.onerror = () => onStatus('lost');
  };
  const close = () => {
    es?.close();
    es = null;
  };
  const onVisibility = () => (document.hidden ? close() : open());
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) open();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    close();
  };
}
