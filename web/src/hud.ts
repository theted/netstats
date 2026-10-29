import type { Flow, Snapshot, Status } from './feed.ts';

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/** Bytes, in the largest unit that keeps the number under a thousand. */
export function formatBytes(b: number): string {
  let v = b;
  let u = 0;
  while (v >= 1000 && u < UNITS.length - 1) {
    v /= 1000;
    u++;
  }
  return u === 0 ? `${Math.round(v)} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${UNITS[u]}`;
}

/** Bytes per second, as formatBytes puts them. */
export const formatRate = (b: number) => `${formatBytes(b)}/s`;

export function el(tag: string, className: string, parent: HTMLElement, text = '') {
  const e = document.createElement(tag);
  e.className = className;
  e.textContent = text;
  parent.appendChild(e);
  return e;
}

function place(f: Flow) {
  return [f.city, f.cc].filter(Boolean).join(', ') || 'unknown place';
}

/** The label a person would recognise: the DNS name if one was seen, else the address, else the place. */
export function flowName(f: Flow) {
  return f.host || f.ip || place(f);
}

/**
 * The text around the globe: live totals top left, the busiest hosts bottom left, help and
 * attribution bottom right, and a tooltip for the endpoint under the pointer. Everything is set with
 * textContent: host names come off the wire and are not to be trusted as markup.
 */
export class Hud {
  private readonly dot: HTMLElement;
  private readonly label: HTMLElement;
  private readonly up: HTMLElement;
  private readonly down: HTMLElement;
  private readonly counts: HTMLElement;
  private readonly top: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly note: HTMLElement;

  constructor(root: HTMLElement) {
    const totals = el('div', 'hud totals', root);
    const title = el('div', 'title', totals);
    this.dot = el('span', 'dot', title);
    this.label = el('span', '', title, 'NETSTATS');
    const rates = el('div', 'rates', totals);
    const upLine = el('div', 'up', rates);
    el('span', 'arrow', upLine, '↑');
    this.up = el('span', '', upLine, '—');
    const downLine = el('div', 'down', rates);
    el('span', 'arrow', downLine, '↓');
    this.down = el('span', '', downLine, '—');
    this.counts = el('div', 'counts', totals);

    this.top = el('div', 'hud top', root);

    const help = el('div', 'hud help', root);
    this.note = el('div', '', help, 'Live traffic of this web server · no IP addresses are shown or stored');
    this.note.hidden = true;
    el('div', '', help, 'drag · scroll · h home · s stats · b glow');
    const attribution = el('div', '', help);
    const link = el('a', '', attribution, 'IP geolocation by DB-IP') as HTMLAnchorElement;
    link.href = 'https://db-ip.com';
    link.target = '_blank';
    link.rel = 'noreferrer';

    this.tip = el('div', 'hud tip', root);
  }

  status = (s: Status) => {
    this.dot.className = `dot ${s === 'live' || s === 'demo' ? 'live' : s === 'lost' ? 'lost' : ''}`;
    this.label.textContent = {
      connecting: 'NETSTATS · CONNECTING',
      live: 'NETSTATS',
      lost: 'NETSTATS · DISCONNECTED',
      demo: 'NETSTATS · DEMO DATA',
    }[s];
  };

  snapshot(s: Snapshot) {
    this.up.textContent = formatRate(s.up);
    this.down.textContent = formatRate(s.down);
    this.note.hidden = !s.public;
    const hosts = s.flows.length + s.unlocated;
    this.counts.textContent =
      `${hosts} host${hosts === 1 ? '' : 's'}` + (s.unlocated ? ` · ${s.unlocated} not on the map` : '');

    this.top.replaceChildren();
    const busiest = [...s.flows].sort((a, b) => b.up + b.down - (a.up + a.down));
    for (const f of busiest.slice(0, 6)) {
      if (f.up + f.down < 1) break;
      const row = el('div', '', this.top);
      el('span', 'name', row, `${flowName(f)}${f.proc ? ` · ${f.proc}` : ''}`);
      el('span', '', row, formatRate(f.up + f.down));
    }
  }

  hover(f: Flow | null, x = 0, y = 0) {
    if (!f) {
      this.tip.classList.remove('show');
      return;
    }
    this.tip.replaceChildren();
    const name = flowName(f);
    el('div', 'head', this.tip, name);
    const where = [f.host ? f.ip : '', place(f)].filter((s) => s && s !== name).join(' · ');
    el('div', 'sub', this.tip, where);
    const what = [f.proc, `${f.proto}/${f.port}`, f.rtt ? `${Math.round(f.rtt)} ms` : ''].filter(Boolean).join(' · ');
    el('div', 'sub', this.tip, what);
    const rates = el('div', '', this.tip);
    el('span', 'up', rates, `↑ ${formatRate(f.up)}`);
    el('span', '', rates, '   ');
    el('span', 'down', rates, `↓ ${formatRate(f.down)}`);
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
    this.tip.classList.add('show');
  }
}
