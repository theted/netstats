import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Arcs } from './arcs.ts';
import { farSide } from './far-side.ts';
import { connect, demo, type Snapshot } from './feed.ts';
import { facing } from './geo.ts';
import { Globe } from './globe.ts';
import { Hud } from './hud.ts';
import { Controls, type Settings } from './settings.ts';
import { Spin } from './spin.ts';
import { setTheme, themeFrom, THEMES } from './theme.ts';
import './style.css';

const FOV = 40;
/**
 * Spring dynamics: the globe trailing and overshooting a drag, the tilt bouncing back to rest, zoom
 * bouncing off its stops, and arcs overshooting as they rise. Off by default; `?springs` turns it on
 * for one page load.
 */
const SPRINGS = false;
/**
 * A see-through globe: coastlines, arcs and pulses on the far side show through it at
 * FAR_SIDE_BRIGHTNESS. `?solid` or `?translucent` overrides it for one page load.
 */
const TRANSLUCENT = true;
const FAR_SIDE_BRIGHTNESS = 0.28;
const params = new URLSearchParams(location.search);
const springs = SPRINGS || params.has('springs');
const translucent = params.has('solid') ? false : TRANSLUCENT || params.has('translucent');
farSide.value = translucent ? FAR_SIDE_BRIGHTNESS : 0;
/** Radius, in globe radii, that must fit the shorter side of the view: the globe plus most arcs. */
const FRAME_RADIUS = 1.42;

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);

const globe = new Globe(translucent);
const arcs = new Arcs(springs);
globe.group.add(arcs.ribbons, arcs.ends, arcs.pulses.mesh, arcs.dots.points);
scene.add(globe.group);
globe.loadLand(`${import.meta.env.BASE_URL}geo/countries-110m.json`).catch((e) => console.error('coastlines:', e));

const hud = new Hud(app);

/** Where the globe rests: home turned to face us, tilted part of the way toward its latitude. */
function restView(home: Snapshot['home']) {
  const f = facing(home.lon, home.lat);
  return { yaw: f.yaw, pitch: THREE.MathUtils.clamp(f.pitch * 0.6, -0.5, 0.5) };
}

let home: Snapshot['home'] | null = null;
const spin = new Spin(renderer.domElement, FOV, { ...restView({ lat: 50, lon: 10 }), dist: 4 }, springs);

function onSnapshot(s: Snapshot) {
  if (!home) spin.jumpTo(restView(s.home));
  home = s.home;
  globe.setHome(s.home.lon, s.home.lat);
  arcs.setHome(s.home.lon, s.home.lat);
  arcs.sync(s);
  hud.snapshot(s);
}

(params.has('demo') ? demo : connect)(onSnapshot, hud.status);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.3, 0.12);
composer.addPass(bloom);
composer.addPass(new OutputPass());
let glow = true;

function apply(s: Settings) {
  spin.autospin = s.autospin;
  arcs.trail = s.trail;
  arcs.dots.points.visible = s.dots;
  glow = s.glow;
  setTheme(s.theme === 'custom' ? themeFrom(s.custom) : THEMES[s.theme]);
}
const controls = new Controls(app, apply);
if (params.has('noglow')) controls.set({ glow: false }, false);
apply(controls.settings);

let width = 1;
let height = 1;
let pixelRatio = 1;
function resize() {
  width = app.clientWidth;
  height = app.clientHeight;
  pixelRatio = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const halfFov = THREE.MathUtils.degToRad(FOV / 2);
  spin.setFramedDistance(FRAME_RADIUS / Math.sin(halfFov) / Math.min(1, camera.aspect));
}
new ResizeObserver(resize).observe(app);
resize();

let pointer: { x: number; y: number } | null = null;
const canvas = renderer.domElement;
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
});
canvas.addEventListener('pointerleave', () => (pointer = null));

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'b') controls.set({ glow: !glow });
  if (e.key === 'h' && home) spin.lookAt(restView(home));
});

const start = performance.now();
let last = start;
function frame(now: number) {
  render(Math.min((now - last) / 1000, 0.25), (now - start) / 1000);
  last = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function render(dt: number, time: number) {

  spin.update(dt);
  globe.group.rotation.set(spin.pitch, spin.yaw, 0);
  camera.position.set(0, 0, spin.dist);
  camera.lookAt(0, 0, 0);
  scene.updateMatrixWorld();

  const hovered = pointer && !spin.isDragging ? arcs.pick(pointer.x, pointer.y, camera, globe.group, width, height) : null;
  arcs.hovered = hovered?.id ?? null;
  hud.hover(hovered, pointer?.x, pointer?.y);
  canvas.className = spin.isDragging ? 'dragging' : hovered ? 'pointing' : '';

  arcs.update(dt, time, width, height, pixelRatio);
  globe.update(time, pixelRatio);
  if (glow) composer.render(dt);
  else renderer.render(scene, camera);
}

if (import.meta.env.DEV) {
  // Lets a hidden automation tab, where requestAnimationFrame never fires, be stepped by hand.
  let debugTime = 0;
  const step = (frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i++) render(dt, (debugTime += dt));
  };
  Object.assign(window, { netstats: { arcs, renderer, scene, camera, spin, controls, step } });
}
