import * as THREE from 'three';
import { el } from './hud.ts';
import { cornerPanel } from './panel.ts';
import { DEFAULT_THEME, THEMES, type ThemeName } from './theme.ts';

export interface Settings {
  /** The globe turns by itself when left alone. */
  autospin: boolean;
  /** Seconds an arc takes to fade once its host has dropped out of the feed. */
  trail: number;
  /** Show a dot wherever a host has been seen since the page opened. */
  dots: boolean;
  glow: boolean;
  /** Arcs fly low, like a plane's route, rather than bowing up off the globe. */
  flight: boolean;
  /** A preset, or the colour picked in `custom`. */
  theme: ThemeName | 'custom';
  custom: string;
}

type Toggle = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
const TOGGLES: Toggle[] = ['autospin', 'glow', 'dots', 'flight'];

/** The trail slider's stops, in seconds. */
const TRAILS = [0, 10, 30, 60, 120, 300, 600];
const DEFAULTS: Settings = {
  autospin: true,
  trail: 0,
  dots: false,
  glow: true,
  flight: false,
  theme: DEFAULT_THEME,
  custom: '#ff6a3d',
};
const KEY = 'netstats:settings';

const COG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

function trailText(seconds: number) {
  if (seconds === 0) return 'none';
  return seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
}

/** Saved settings over the defaults, ignoring anything that isn't a valid value. */
function load(): Settings {
  const s = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const key of TOGGLES) if (typeof saved[key] === 'boolean') s[key] = saved[key];
    if (TRAILS.includes(saved.trail)) s.trail = saved.trail;
    if (saved.theme === 'custom' || Object.hasOwn(THEMES, saved.theme)) s.theme = saved.theme;
    if (/^#[0-9a-f]{6}$/i.test(saved.custom)) s.custom = saved.custom;
  } catch {
    // no storage, or something unreadable in it: start from the defaults
  }
  return s;
}

function save(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: the settings last as long as the page
  }
}

/** The cog in the top right corner and the panel it opens. Settings are kept in this browser's localStorage. */
export class Controls {
  settings = load();
  /** Puts each input in step with the settings. */
  private readonly refresh: (() => void)[] = [];

  constructor(
    corner: HTMLElement,
    private readonly onChange: (s: Settings) => void,
  ) {
    const { button, panel } = cornerPanel(corner, 'settings', 'Settings', COG);
    button.classList.add('cog');

    this.check(panel, 'autospin', 'spin by itself');
    this.check(panel, 'glow', 'glow');
    this.check(panel, 'dots', 'keep a dot where hosts were');
    this.check(panel, 'flight', 'flight paths instead of arcs');

    const trail = el('label', 'slider', panel);
    const row = el('div', 'row', trail);
    el('span', '', row, 'trail');
    const value = el('span', 'value', row);
    const range = el('input', '', trail) as HTMLInputElement;
    range.type = 'range';
    range.min = '0';
    range.max = String(TRAILS.length - 1);
    range.addEventListener('input', () => this.set({ trail: TRAILS[Number(range.value)] }));
    el('div', 'note', trail, 'how long an arc fades after its host leaves');
    this.refresh.push(() => {
      range.value = String(TRAILS.indexOf(this.settings.trail));
      value.textContent = trailText(this.settings.trail);
    });

    const colors = el('fieldset', 'colors', panel);
    el('legend', '', colors, 'color');
    const swatches = el('div', 'swatches', colors);
    for (const [name, theme] of Object.entries(THEMES)) {
      const swatch = el('label', 'swatch', swatches);
      swatch.title = name;
      swatch.style.setProperty('--swatch', theme.accent);
      const input = el('input', '', swatch) as HTMLInputElement;
      input.type = 'radio';
      input.name = 'theme';
      input.setAttribute('aria-label', name);
      input.addEventListener('change', () => this.set({ theme: name as ThemeName }));
      this.refresh.push(() => (input.checked = this.settings.theme === name));
    }
    // Any colour: choosing the swatch brings back the last one picked, and a field to pick another.
    const custom = el('label', 'swatch custom', swatches);
    custom.title = 'any color';
    const choose = el('input', '', custom) as HTMLInputElement;
    choose.type = 'radio';
    choose.name = 'theme';
    choose.setAttribute('aria-label', 'any color');
    choose.addEventListener('change', () => this.set({ theme: 'custom' }));
    const field = colorField(colors, (color) => this.set({ theme: 'custom', custom: color }));
    this.refresh.push(() => {
      choose.checked = this.settings.theme === 'custom';
      custom.style.setProperty('--swatch', this.settings.custom);
      field.show(this.settings.theme === 'custom' ? this.settings.custom : null);
    });

    const reset = el('button', 'reset', panel, 'defaults');
    reset.addEventListener('click', () => this.set({ ...DEFAULTS, custom: this.settings.custom }));

    for (const r of this.refresh) r();
  }

  /**
   * Changes settings, from the panel or a keyboard shortcut, and keeps the panel in step. With keep
   * false the change lasts only for this page load, as for a URL switch.
   */
  set(change: Partial<Settings>, keep = true) {
    this.settings = { ...this.settings, ...change };
    for (const r of this.refresh) r();
    if (keep) save(this.settings);
    this.onChange(this.settings);
  }

  private check(panel: HTMLElement, key: Toggle, text: string) {
    const label = el('label', 'check', panel);
    const input = el('input', '', label) as HTMLInputElement;
    input.type = 'checkbox';
    el('span', '', label, text);
    input.addEventListener('change', () => this.set({ [key]: input.checked }));
    this.refresh.push(() => (input.checked = this.settings[key]));
  }
}

/** The palest the colour field goes, as an HSL lightness: themeFrom lifts nothing past it. */
const PALEST = 0.8;

/**
 * A field to pick a colour in: hue across, and from vivid at the bottom to pale at the top. The
 * page draws it, unlike the browser's own picker, which can open off the edge of the screen. Arrow
 * keys move the mark too.
 */
function colorField(parent: HTMLElement, onPick: (color: string) => void) {
  const field = el('div', 'field', parent);
  const mark = el('div', 'mark', field);
  field.tabIndex = 0;
  field.setAttribute('role', 'slider');
  field.setAttribute('aria-label', 'color: left and right for the hue, up and down for how pale');
  field.setAttribute('aria-valuemin', '0');
  field.setAttribute('aria-valuemax', '360');
  let hue = 0;
  let pale = 0;

  const pick = (h: number, p: number) => {
    const color = new THREE.Color().setHSL(h, 1, 0.5 + (PALEST - 0.5) * clamp(p, 0, 1), THREE.SRGBColorSpace);
    onPick(`#${color.getHexString()}`);
  };
  const pointAt = (e: PointerEvent) => {
    const r = field.getBoundingClientRect();
    pick(clamp((e.clientX - r.left) / r.width, 0, 0.999), 1 - (e.clientY - r.top) / r.height);
  };
  field.addEventListener('pointerdown', (e) => {
    field.setPointerCapture(e.pointerId);
    pointAt(e);
  });
  field.addEventListener('pointermove', (e) => {
    if (field.hasPointerCapture(e.pointerId)) pointAt(e);
  });
  field.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-1 / 72, 0], ArrowRight: [1 / 72, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[e.key];
    if (!step) return;
    e.preventDefault();
    pick(hue + step[0], pale + step[1]);
  });

  return {
    /** Shows the field with its mark on a colour, or hides it. */
    show(color: string | null) {
      field.hidden = color === null;
      if (color === null) return;
      const hsl = { h: 0, s: 0, l: 0 };
      new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);
      hue = hsl.h;
      pale = clamp((hsl.l - 0.5) / (PALEST - 0.5), 0, 1);
      mark.style.left = `${hue * 100}%`;
      mark.style.top = `${(1 - pale) * 100}%`;
      mark.style.background = color;
      field.setAttribute('aria-valuenow', String(Math.round(hue * 360)));
      field.setAttribute('aria-valuetext', color);
    },
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
