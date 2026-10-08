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

interface DemoHost {
  city: string;
  cc: string;
  lat: number;
  lon: number;
  host: string;
  proc: string;
  rtt: number;
}

const DEMO_HOSTS: DemoHost[] = [
  { city: 'Frankfurt', cc: 'DE', lat: 50.11, lon: 8.68, host: 'fonts.gstatic.com', proc: 'chromium', rtt: 24 },
  { city: 'London', cc: 'GB', lat: 51.51, lon: -0.13, host: 'www.bbc.co.uk', proc: 'chromium', rtt: 31 },
  { city: 'Amsterdam', cc: 'NL', lat: 52.37, lon: 4.9, host: 'github.com', proc: 'git', rtt: 22 },
  { city: 'Dublin', cc: 'IE', lat: 53.35, lon: -6.26, host: 's3.eu-west-1.amazonaws.com', proc: 'aws', rtt: 38 },
  { city: 'Paris', cc: 'FR', lat: 48.86, lon: 2.35, host: 'cdn.jsdelivr.net', proc: 'chromium', rtt: 29 },
  { city: 'Ashburn', cc: 'US', lat: 39.04, lon: -77.49, host: 'registry.npmjs.org', proc: 'node', rtt: 102 },
  { city: 'San Francisco', cc: 'US', lat: 37.77, lon: -122.42, host: 'api.anthropic.com', proc: 'claude', rtt: 168 },
  { city: 'Seattle', cc: 'US', lat: 47.61, lon: -122.33, host: 'discord.com', proc: 'discord', rtt: 160 },
  { city: 'Dallas', cc: 'US', lat: 32.78, lon: -96.8, host: 'api.spotify.com', proc: 'spotify', rtt: 130 },
  { city: 'New York', cc: 'US', lat: 40.71, lon: -74.0, host: 'news.ycombinator.com', proc: 'chromium', rtt: 95 },
  { city: 'Tokyo', cc: 'JP', lat: 35.68, lon: 139.69, host: 'pbs.twimg.com', proc: 'chromium', rtt: 250 },
  { city: 'Singapore', cc: 'SG', lat: 1.35, lon: 103.82, host: 'ntp.example.sg', proc: 'chronyd', rtt: 190 },
  { city: 'Sydney', cc: 'AU', lat: -33.87, lon: 151.21, host: 'mirror.aarnet.edu.au', proc: 'pacman', rtt: 300 },
  { city: 'São Paulo', cc: 'BR', lat: -23.55, lon: -46.63, host: 'video.example.br', proc: 'mpv', rtt: 210 },
  { city: 'Mumbai', cc: 'IN', lat: 19.08, lon: 72.88, host: 'api.example.in', proc: 'chromium', rtt: 140 },
  { city: 'Johannesburg', cc: 'ZA', lat: -26.2, lon: 28.05, host: 'cdn.example.za', proc: 'chromium', rtt: 180 },
  { city: 'Helsinki', cc: 'FI', lat: 60.17, lon: 24.94, host: 'hetzner.com', proc: 'ssh', rtt: 9 },
  { city: 'Oslo', cc: 'NO', lat: 59.91, lon: 10.75, host: 'vg.no', proc: 'chromium', rtt: 12 },
  { city: 'Toronto', cc: 'CA', lat: 43.65, lon: -79.38, host: 'slack.com', proc: 'slack', rtt: 110 },
  { city: 'Hong Kong', cc: 'HK', lat: 22.32, lon: 114.17, host: 'cdn.example.hk', proc: 'chromium', rtt: 230 },
  { city: 'Seoul', cc: 'KR', lat: 37.57, lon: 126.98, host: 'game.example.kr', proc: 'steam', rtt: 260 },
  { city: 'Warsaw', cc: 'PL', lat: 52.23, lon: 21.01, host: 'allegro.pl', proc: 'chromium', rtt: 28 },
  { city: 'Madrid', cc: 'ES', lat: 40.42, lon: -3.7, host: 'elpais.com', proc: 'chromium', rtt: 52 },
  { city: 'Stockholm', cc: 'SE', lat: 59.33, lon: 18.07, host: 'svt.se', proc: 'chromium', rtt: 4 },
];

interface DemoFlow {
  h: DemoHost;
  ip: string;
  base: number;
  ratio: number;
  phase: number;
  born: number;
  life: number;
}

/**
 * A synthetic feed with the same shape as the collector's, so the globe can be developed and shown
 * without capture rights. Hosts come and go, and rates swell and fade.
 */
export function demo(onSnapshot: (s: Snapshot) => void, onStatus: (s: Status) => void): () => void {
  onStatus('demo');
  const home = { lat: 59.33, lon: 18.07, city: 'Stockholm' };
  const flows: DemoFlow[] = [];
  let serial = 0;

  const spawn = (now: number) => {
    const h = DEMO_HOSTS[Math.floor(Math.random() * DEMO_HOSTS.length)];
    serial++;
    flows.push({
      h,
      ip: `203.0.${serial % 250}.${(serial * 37) % 250}`,
      base: 10 ** (2 + Math.random() * 4.3), // 100 B/s to 2 MB/s
      ratio: Math.random() < 0.8 ? 0.05 + Math.random() * 0.15 : 1 + Math.random() * 3, // mostly downloads
      phase: Math.random() * Math.PI * 2,
      born: now,
      life: 8 + Math.random() * 40,
    });
  };

  const start = performance.now() / 1000;
  for (let i = 0; i < 14; i++) spawn(start - Math.random() * 10);

  const timer = setInterval(() => {
    const now = performance.now() / 1000;
    for (let i = flows.length - 1; i >= 0; i--) if (now - flows[i].born > flows[i].life) flows.splice(i, 1);
    if (flows.length < 22 && Math.random() < 0.18) spawn(now);

    let up = 0;
    let down = 0;
    const out = flows.map((f) => {
      const swell = 0.5 + 0.5 * Math.sin(now * 0.7 + f.phase);
      const d = f.base * swell * swell;
      const u = d * f.ratio;
      up += u;
      down += d;
      return {
        id: f.ip,
        ip: f.ip,
        lat: f.h.lat,
        lon: f.h.lon,
        city: f.h.city,
        cc: f.h.cc,
        host: f.h.host,
        proc: f.h.proc,
        proto: 'tcp',
        port: 443,
        up: Math.round(u),
        down: Math.round(d),
        rtt: f.h.rtt,
      };
    });
    onSnapshot({ t: Date.now(), home, up, down, unlocated: 2, flows: out });
  }, 250);
  return () => clearInterval(timer);
}
