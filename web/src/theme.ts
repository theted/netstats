import * as THREE from 'three';

interface Theme {
  /** Coastlines, the rim, home, arc ends and the HUD text. */
  accent: string;
  /** Arcs at rest: darker than the accent, so the pulses riding them carry the eye. */
  arc: string;
  up: string;
  down: string;
}

export const THEMES = {
  phosphor: { accent: '#00ff55', arc: '#0c9e44', up: '#c8ff3c', down: '#29ff8c' },
  amber: { accent: '#ffb000', arc: '#a86400', up: '#fff27a', down: '#ff7b1c' },
  ice: { accent: '#00e1ff', arc: '#0b86a0', up: '#c4f8ff', down: '#3d8bff' },
  synth: { accent: '#ff3ecf', arc: '#a02a86', up: '#ffd84a', down: '#9d6bff' },
  mono: { accent: '#e6eef5', arc: '#7d8794', up: '#ffffff', down: '#9fc4ff' },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;

/**
 * The scene's colours. Every material holds these objects themselves as uniform values, so
 * setTheme changes them in place and the next frame draws in the new colours. The HUD follows
 * through CSS variables.
 */
export const ACCENT = new THREE.Color(THEMES.phosphor.accent);
export const ARC_COLOR = new THREE.Color(THEMES.phosphor.arc);
export const UP_COLOR = new THREE.Color(THEMES.phosphor.up);
export const DOWN_COLOR = new THREE.Color(THEMES.phosphor.down);

export function setTheme(name: ThemeName) {
  const t: Theme = THEMES[name];
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
