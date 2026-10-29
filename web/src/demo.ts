import type { Flow, Snapshot, Stats, Status } from './feed.ts';
import { kmBetween } from './geo.ts';

interface DemoHost {
  city: string;
  cc: string;
  lat: number;
  lon: number;
  host: string;
  proc: string;
  rtt: number;
  /** Anything but https: [protocol, port]. */
  service?: [string, number];
}

const DEMO_HOSTS: DemoHost[] = [
  { city: 'Frankfurt', cc: 'DE', lat: 50.11, lon: 8.68, host: 'fonts.gstatic.com', proc: 'chromium', rtt: 24 },
  { city: 'London', cc: 'GB', lat: 51.51, lon: -0.13, host: 'www.bbc.co.uk', proc: 'chromium', rtt: 31 },
  { city: 'Amsterdam', cc: 'NL', lat: 52.37, lon: 4.9, host: 'github.com', proc: 'git', rtt: 22, service: ['tcp', 22] },
  { city: 'Dublin', cc: 'IE', lat: 53.35, lon: -6.26, host: 's3.eu-west-1.amazonaws.com', proc: 'aws', rtt: 38 },
  { city: 'Paris', cc: 'FR', lat: 48.86, lon: 2.35, host: 'cdn.jsdelivr.net', proc: 'chromium', rtt: 29 },
  { city: 'Ashburn', cc: 'US', lat: 39.04, lon: -77.49, host: 'registry.npmjs.org', proc: 'node', rtt: 102 },
  { city: 'San Francisco', cc: 'US', lat: 37.77, lon: -122.42, host: 'api.anthropic.com', proc: 'claude', rtt: 168 },
  { city: 'Seattle', cc: 'US', lat: 47.61, lon: -122.33, host: 'discord.com', proc: 'discord', rtt: 160 },
  { city: 'Dallas', cc: 'US', lat: 32.78, lon: -96.8, host: 'api.spotify.com', proc: 'spotify', rtt: 130 },
  { city: 'New York', cc: 'US', lat: 40.71, lon: -74.0, host: 'news.ycombinator.com', proc: 'chromium', rtt: 95 },
  { city: 'Tokyo', cc: 'JP', lat: 35.68, lon: 139.69, host: 'pbs.twimg.com', proc: 'chromium', rtt: 250, service: ['udp', 443] },
  { city: 'Singapore', cc: 'SG', lat: 1.35, lon: 103.82, host: 'ntp.example.sg', proc: 'chronyd', rtt: 190, service: ['udp', 123] },
  { city: 'Sydney', cc: 'AU', lat: -33.87, lon: 151.21, host: 'mirror.aarnet.edu.au', proc: 'pacman', rtt: 300 },
  { city: 'São Paulo', cc: 'BR', lat: -23.55, lon: -46.63, host: 'video.example.br', proc: 'mpv', rtt: 210, service: ['udp', 443] },
  { city: 'Mumbai', cc: 'IN', lat: 19.08, lon: 72.88, host: 'api.example.in', proc: 'chromium', rtt: 140 },
  { city: 'Johannesburg', cc: 'ZA', lat: -26.2, lon: 28.05, host: 'cdn.example.za', proc: 'chromium', rtt: 180 },
  { city: 'Helsinki', cc: 'FI', lat: 60.17, lon: 24.94, host: 'hetzner.com', proc: 'ssh', rtt: 9, service: ['tcp', 22] },
  { city: 'Oslo', cc: 'NO', lat: 59.91, lon: 10.75, host: 'vg.no', proc: 'chromium', rtt: 12 },
  { city: 'Toronto', cc: 'CA', lat: 43.65, lon: -79.38, host: 'slack.com', proc: 'slack', rtt: 110 },
  { city: 'Hong Kong', cc: 'HK', lat: 22.32, lon: 114.17, host: 'cdn.example.hk', proc: 'chromium', rtt: 230 },
  { city: 'Seoul', cc: 'KR', lat: 37.57, lon: 126.98, host: 'game.example.kr', proc: 'steam', rtt: 260, service: ['udp', 27015] },
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

const TICK = 0.25;
/** The demo's stats go out once every this many ticks, as the collector's do: about once a second. */
const STATS_EVERY = 4;

/**
 * A synthetic feed with the same shape as the collector's, so the globe can be developed and shown
 * without capture rights. Hosts come and go, and rates swell and fade.
 */
export function demo(onSnapshot: (s: Snapshot) => void, onStatus: (s: Status) => void): () => void {
  onStatus('demo');
  const home = { lat: 59.33, lon: 18.07, city: 'Stockholm' };
  const flows: DemoFlow[] = [];
  const tally = new DemoTally(home);
  let serial = 0;
  let ticks = 0;

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
    const out = flows.map((f): Flow => {
      const swell = 0.5 + 0.5 * Math.sin(now * 0.7 + f.phase);
      const d = f.base * swell * swell;
      const u = d * f.ratio;
      up += u;
      down += d;
      const [proto, port] = f.h.service ?? ['tcp', 443];
      return {
        id: f.ip,
        ip: f.ip,
        lat: f.h.lat,
        lon: f.h.lon,
        city: f.h.city,
        cc: f.h.cc,
        host: f.h.host,
        proc: f.h.proc,
        proto,
        port,
        up: Math.round(u),
        down: Math.round(d),
        rtt: f.h.rtt,
      };
    });
    tally.record(out);
    const t = Date.now();
    const stats = ticks++ % STATS_EVERY === 0 ? tally.report() : undefined;
    onSnapshot({ t, home, up, down, unlocated: 2, flows: out, stats });
  }, TICK * 1000);
  return () => clearInterval(timer);
}

/** Running totals of the made-up traffic, kept as the collector keeps its own. */
class DemoTally {
  private readonly since = Date.now();
  /** A made-up machine, up for three days, which moved this much before the page opened. */
  private readonly boot = this.since - 3.2 * 86400e3;
  private readonly before = { up: 3.9e9, down: 41.3e9 };
  private up = 0;
  private down = 0;
  private peakUp = 0;
  private peakDown = 0;
  private readonly hosts = new Set<string>();
  private readonly countries = new Map<string, { bytes: number; hosts: Set<string> }>();
  private readonly services = new Map<string, Stats['services'][number]>();
  private farthest: Stats['farthest'];

  constructor(private readonly home: { lat: number; lon: number }) {}

  record(flows: Flow[]) {
    let up = 0;
    let down = 0;
    for (const f of flows) {
      up += f.up;
      down += f.down;
      const bytes = (f.up + f.down) * TICK;
      this.up += f.up * TICK;
      this.down += f.down * TICK;
      this.hosts.add(f.id);
      const key = `${f.proto}/${f.port}`;
      const service = this.services.get(key) ?? { proto: f.proto, port: f.port, bytes: 0 };
      service.bytes += bytes;
      this.services.set(key, service);
      const cc = f.cc!;
      const country = this.countries.get(cc) ?? { bytes: 0, hosts: new Set<string>() };
      country.bytes += bytes;
      country.hosts.add(f.id);
      this.countries.set(cc, country);
      const km = kmBetween(this.home, f);
      if (km > (this.farthest?.km ?? 0)) this.farthest = { city: f.city, cc, km: Math.round(km) };
    }
    this.peakUp = Math.max(this.peakUp, up);
    this.peakDown = Math.max(this.peakDown, down);
  }

  report(): Stats {
    const captured = { up: Math.round(this.up), down: Math.round(this.down) };
    return {
      since: this.since,
      boot: this.boot,
      ...captured,
      peakUp: this.peakUp,
      peakDown: this.peakDown,
      hosts: this.hosts.size,
      iface: { name: 'eth0', up: this.before.up + captured.up * 1.08, down: this.before.down + captured.down * 1.08 },
      countries: [...this.countries].map(([cc, c]) => ({ cc, bytes: Math.round(c.bytes), hosts: c.hosts.size })),
      countryCount: this.countries.size,
      services: [...this.services.values()].map((s) => ({ ...s, bytes: Math.round(s.bytes) })),
      farthest: this.farthest,
    };
  }
}
