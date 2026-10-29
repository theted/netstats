import * as THREE from 'three';

export interface Theme {
  /** Coastlines, the rim, home, arc ends and the HUD text. */
  accent: string;
  /** Arcs at rest: darker than the accent, so the pulses riding them carry the eye. */
  arc: string;
  up: string;
  down: string;
}

export const THEMES = {
  ice: { accent: '#00e1ff', arc: '#0b86a0', up: '#c4f8ff', down: '#3d8bff' },
  phosphor: { accent: '#00ff55', arc: '#0c9e44', up: '#c8ff3c', down: '#29ff8c' },
  amber: { accent: '#ffb000', arc: '#a86400', up: '#fff27a', down: '#ff7b1c' },
  synth: { accent: '#ff3ecf', arc: '#a02a86', up: '#ffd84a', down: '#9d6bff' },
  mono: { accent: '#e6eef5', arc: '#7d8794', up: '#ffffff', down: '#9fc4ff' },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

/** The theme until one is picked: cyan, with downloads in blue. */
export const DEFAULT_THEME: ThemeName = 'ice';

/**
 * The scene's colours. Every material holds these objects themselves as uniform values, so
 * setTheme changes them in place and the next frame draws in the new colours. The HUD follows
 * through CSS variables.
 */
export const ACCENT = new THREE.Color(THEMES[DEFAULT_THEME].accent);
export const ARC_COLOR = new THREE.Color(THEMES[DEFAULT_THEME].arc);
export const UP_COLOR = new THREE.Color(THEMES[DEFAULT_THEME].up);
export const DOWN_COLOR = new THREE.Color(THEMES[DEFAULT_THEME].down);

/**
 * A theme for any colour, paired the way the presets are: arcs in a darker shade of it, uploads
 * lighter and turned a little round the colour wheel, downloads turned the other way. A dark pick
 * is lifted, since it wouldn't show against the black.
 */
export function themeFrom(color: string): Theme {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(color).getHSL(hsl, THREE.SRGBColorSpace);
  const { h, s } = hsl;
  const l = Math.min(Math.max(hsl.l, 0.45), 0.8);
  const shade = (turn: number, sat: number, light: number) =>
    `#${new THREE.Color().setHSL(h + turn / 360, s * sat, Math.min(light, 0.9), THREE.SRGBColorSpace).getHexString()}`;
  return { accent: shade(0, 1, l), arc: shade(0, 0.86, l * 0.66), up: shade(-35, 1, l + 0.15), down: shade(25, 1, l + 0.08) };
}

export function setTheme(t: Theme) {
  ACCENT.set(t.accent);
  ARC_COLOR.set(t.arc);
  UP_COLOR.set(t.up);
  DOWN_COLOR.set(t.down);
  const css = document.documentElement.style;
  css.setProperty('--accent', t.accent);
  css.setProperty('--accent-rgb', [1, 3, 5].map((i) => parseInt(t.accent.slice(i, i + 2), 16)).join(' '));
  css.setProperty('--up', t.up);
  css.setProperty('--down', t.down);
}
