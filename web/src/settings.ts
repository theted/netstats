import { el } from './hud.ts';
import { THEMES, type ThemeName } from './theme.ts';

export interface Settings {
  /** The globe turns by itself when left alone. */
  autospin: boolean;
  /** Seconds an arc takes to fade once its host has dropped out of the feed. */
  trail: number;
  /** Show a dot wherever a host has been seen since the page opened. */
  dots: boolean;
  glow: boolean;
  /** A preset, or the colour picked in `custom`. */
  theme: ThemeName | 'custom';
  custom: string;
}

/** The trail slider's stops, in seconds. */
const TRAILS = [0, 10, 30, 60, 120, 300, 600];
const DEFAULTS: Settings = { autospin: true, trail: 0, dots: false, glow: true, theme: 'phosphor', custom: '#ff6a3d' };
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
    if (typeof saved.autospin === 'boolean') s.autospin = saved.autospin;
    if (TRAILS.includes(saved.trail)) s.trail = saved.trail;
    if (typeof saved.dots === 'boolean') s.dots = saved.dots;
    if (typeof saved.glow === 'boolean') s.glow = saved.glow;
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

/**
 * The cog in the top right corner and the panel it opens. The panel is a popover, so it closes on
 * Escape or a click elsewhere, and leaves the globe free to drag while it's open. Settings are kept
 * in this browser's localStorage.
 */
export class Controls {
  settings = load();
  /** Puts each input in step with the settings. */
  private readonly refresh: (() => void)[] = [];

  constructor(
    root: HTMLElement,
    private readonly onChange: (s: Settings) => void,
  ) {
    const cog = el('button', 'cog', root);
    cog.innerHTML = COG;
    cog.title = 'Settings';
    cog.setAttribute('aria-label', 'Settings');
    cog.setAttribute('popovertarget', 'settings');

    const panel = el('div', 'settings', root);
    panel.id = 'settings';
    panel.setAttribute('popover', '');
    const head = el('div', 'head', panel);
    el('span', '', head, 'SETTINGS');
    const close = el('button', 'close', head, '×');
    close.setAttribute('aria-label', 'Close');
    close.setAttribute('popovertarget', 'settings');
    close.setAttribute('popovertargetaction', 'hide');

    this.check(panel, 'autospin', 'spin by itself');
    this.check(panel, 'glow', 'glow');
    this.check(panel, 'dots', 'keep a dot where hosts were');

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
    // Any colour: choosing the swatch brings back the last one picked, and opens the picker.
    const custom = el('label', 'swatch custom', swatches);
    custom.title = 'any color';
    const picker = el('input', '', custom) as HTMLInputElement;
    picker.type = 'color';
    picker.setAttribute('aria-label', 'any color');
    picker.addEventListener('click', () => this.set({ theme: 'custom' }));
    picker.addEventListener('input', () => this.set({ theme: 'custom', custom: picker.value }));
    this.refresh.push(() => {
      picker.value = this.settings.custom;
      custom.style.setProperty('--swatch', this.settings.custom);
      custom.classList.toggle('on', this.settings.theme === 'custom');
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

  private check(panel: HTMLElement, key: 'autospin' | 'glow' | 'dots', text: string) {
    const label = el('label', 'check', panel);
    const input = el('input', '', label) as HTMLInputElement;
    input.type = 'checkbox';
    el('span', '', label, text);
    input.addEventListener('change', () => this.set({ [key]: input.checked }));
    this.refresh.push(() => (input.checked = this.settings[key]));
  }
}
