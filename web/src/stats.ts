import type { Stats } from './feed.ts';
import { el, formatBytes, formatRate } from './hud.ts';
import { cornerPanel } from './panel.ts';

const BARS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 20h16M7 16v-4M12 16V6M17 16V9"/></svg>`;

/** How many countries and services the panel lists. */
const COUNTRIES = 6;
const SERVICES = 5;

/** Names for the services most traffic goes to, by protocol/port. */
const SERVICE_NAMES: Record<string, string> = {
  'tcp/443': 'https',
  'udp/443': 'quic',
  'tcp/80': 'http',
  'tcp/8080': 'http',
  'tcp/8443': 'https',
  'tcp/22': 'ssh',
  'udp/53': 'dns',
  'tcp/53': 'dns',
  'tcp/853': 'dns/tls',
  'udp/123': 'ntp',
  'tcp/25': 'smtp',
  'tcp/465': 'smtp',
  'tcp/587': 'smtp',
  'tcp/993': 'imap',
  'tcp/3389': 'rdp',
  'tcp/9418': 'git',
  'udp/3478': 'stun',
  'udp/1194': 'openvpn',
  'udp/51820': 'wireguard',
  'udp/27015': 'steam',
};

const regions = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(cc: string) {
  try {
    return regions.of(cc) ?? cc;
  } catch {
    return cc; // not a code Intl knows the shape of
  }
}

const count = (n: number) => n.toLocaleString('en');

/** A span of time in its two largest units: "3 d 4 h", "5 h 12 min", "40 s". */
function formatSpan(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [d, h, m] = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60];
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min` : `${s} s`;
}

/** A section with bytes sent and received over a span of time: the total, and each way under it. */
function totals(parent: HTMLElement, label: string) {
  const section = el('section', '', parent);
  const head = el('div', 'label', section);
  const name = el('span', '', head, label);
  const span = el('span', 'span', head);
  const total = el('div', 'total', section);
  const split = el('div', 'split', section);
  const up = el('span', 'up', split);
  const down = el('span', 'down', split);
  return {
    section,
    name,
    show(t: { up: number; down: number }, ms: number) {
      span.textContent = formatSpan(ms);
      total.textContent = formatBytes(t.up + t.down);
      up.textContent = `↑ ${formatBytes(t.up)}`;
      down.textContent = `↓ ${formatBytes(t.down)}`;
    },
  };
}

interface Rank {
  name: string;
  /** Dim text after the name. */
  note?: string;
  cells: [string, string];
  /** Of the whole, for the bar under the row: 0–1. */
  share: number;
}

/**
 * Rows of a ranked list: a name, two value columns, and a bar under each row for its share of the
 * whole. The column ranked by is the bright one.
 */
function ranks(list: HTMLElement, rows: Rank[], by: 0 | 1) {
  list.replaceChildren();
  for (const r of rows) {
    const li = el('li', '', list);
    const name = el('span', 'name', li, r.name);
    if (r.note) el('span', 'note', name, ` ${r.note}`);
    r.cells.forEach((text, i) => el('span', i === by ? 'value' : 'value dim', li, text));
    el('div', 'bar', li).style.setProperty('--share', String(Math.min(1, r.share)));
  }
}

/**
 * The bars button in the top right corner and the panel it opens: running totals since the
 * collector started and since the machine booted, and where the traffic went.
 */
export class StatsPanel {
  private readonly panel: HTMLElement;
  private readonly waiting: HTMLElement;
  private readonly body: HTMLElement;
  private readonly start: ReturnType<typeof totals>;
  private readonly boot: ReturnType<typeof totals>;
  private readonly bootNote: HTMLElement;
  private readonly peak: HTMLElement;
  private readonly hosts: HTMLElement;
  private readonly countryCount: HTMLElement;
  private readonly farthest: HTMLElement;
  private readonly farthestPlace: HTMLElement;
  private readonly countries: HTMLElement;
  private readonly services: HTMLElement;
  private readonly sorts: HTMLButtonElement[] = [];
  /** Countries ranked by hosts (0) or by traffic (1). */
  private by: 0 | 1 = 0;
  private last: { stats: Stats; now: number } | null = null;

  constructor(corner: HTMLElement) {
    this.panel = cornerPanel(corner, 'stats', 'Stats', BARS).panel;
    this.panel.addEventListener('toggle', () => this.render());
    this.waiting = el('div', 'note', this.panel, 'waiting for the first totals…');
    this.body = el('div', '', this.panel);
    this.body.hidden = true;

    this.start = totals(this.body, 'since start');
    this.start.name.title = 'since the collector started: traffic with internet hosts';
    const facts = el('dl', '', this.start.section);
    const fact = (term: string) => {
      el('dt', '', facts, term);
      return el('dd', '', facts);
    };
    this.peak = fact('peak');
    this.hosts = fact('hosts');
    this.hosts.title = 'distinct remote hosts, estimated';
    this.countryCount = fact('countries');
    this.farthest = fact('farthest');
    this.farthestPlace = el('dd', 'place', facts);

    this.boot = totals(this.body, 'since boot');
    this.bootNote = el('div', 'note', this.boot.section);

    const countries = el('section', '', this.body);
    const head = el('div', 'label ranked', countries);
    el('span', '', head, 'countries');
    for (const [i, text] of ['hosts', 'traffic'].entries()) {
      const sort = el('button', 'sort', head, text) as HTMLButtonElement;
      sort.title = `rank by ${text}`;
      sort.addEventListener('click', () => {
        this.by = i as 0 | 1;
        this.render();
      });
      this.sorts.push(sort);
    }
    this.countries = el('ol', 'ranks', countries);

    const services = el('section', '', this.body);
    el('div', 'label', services, 'services');
    this.services = el('ol', 'ranks', services);
  }

  /** Takes the latest totals; now is the collector's clock, so spans of time ignore this one's. */
  update(stats: Stats, now: number) {
    this.last = { stats, now };
    this.render();
  }

  toggle() {
    this.panel.togglePopover();
  }

  private render() {
    if (!this.last || !this.panel.matches(':popover-open')) return;
    const { stats: s, now } = this.last;
    this.waiting.hidden = true;
    this.body.hidden = false;

    this.start.show(s, now - s.since);
    this.peak.replaceChildren();
    el('span', 'up', this.peak, `↑ ${formatRate(s.peakUp)}`);
    el('span', 'down', this.peak, `  ↓ ${formatRate(s.peakDown)}`);
    this.hosts.textContent = count(s.hosts);
    this.countryCount.textContent = count(s.countryCount);
    const far = s.farthest;
    this.farthest.textContent = far ? `${count(far.km)} km` : '—';
    this.farthestPlace.textContent = far ? [far.city, far.cc && countryName(far.cc)].filter(Boolean).join(', ') : '';

    this.boot.section.hidden = !s.iface || !s.boot;
    if (s.iface && s.boot) {
      this.boot.show(s.iface, now - s.boot);
      this.bootNote.textContent = `all of ${s.iface.name}, the LAN included`;
    }

    const bytes = s.up + s.down || 1;
    const metric = (c: Stats['countries'][number]) => (this.by === 0 ? c.hosts : c.bytes);
    const whole = this.by === 0 ? s.hosts || 1 : bytes;
    const countries = [...s.countries].sort((a, b) => metric(b) - metric(a) || b.bytes - a.bytes).slice(0, COUNTRIES);
    ranks(
      this.countries,
      countries.map((c) => ({
        name: countryName(c.cc),
        cells: [count(c.hosts), formatBytes(c.bytes)],
        share: metric(c) / whole,
      })),
      this.by,
    );
    this.sorts.forEach((b, i) => {
      b.classList.toggle('active', i === this.by);
      b.setAttribute('aria-pressed', String(i === this.by));
    });

    const services = [...s.services].sort((a, b) => b.bytes - a.bytes).slice(0, SERVICES);
    ranks(
      this.services,
      services.map((v) => {
        const key = `${v.proto}/${v.port}`;
        const known = SERVICE_NAMES[key];
        return {
          name: known ?? (v.port ? key : 'other ip'),
          note: known && key,
          cells: [formatBytes(v.bytes), `${Math.round((v.bytes / bytes) * 100)}%`],
          share: v.bytes / bytes,
        };
      }),
      0,
    );
  }
}
