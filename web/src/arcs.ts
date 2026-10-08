import * as THREE from 'three';
import type { Flow, Snapshot } from './feed.ts';
import { hash01, lonLatToVec3 } from './geo.ts';
import { GREEN } from './globe.ts';
import { ARC_GLSL } from './arc-shader.ts';
import { FAR_SIDE_GLSL, farSide } from './far-side.ts';
import { Pulses } from './pulses.ts';

/**
 * How arcs look at rest: a darker green than the coastlines, thin, and faint enough that the pulses
 * riding them carry the eye. Hovering an arc lights it up in the full green. Width is the half-width
 * of the line's soft core, in CSS pixels.
 */
const ARC_COLOR = new THREE.Color('#0c9e44');
const ARC_WIDTH = 1.6;
const ARC_OPACITY = 0.3;

/** Arc slots. The collector sends at most 300 flows; the rest is room for arcs fading out. */
export const MAX_ARCS = 512;
const SEGMENTS = 64;
/** A freed slot rests this long before reuse, so no pulse still in flight jumps to a new arc. */
const SLOT_COOLDOWN = 5;
/** Seconds for an arc to draw itself out from home. */
const GROW_TIME = 0.7;
/** With springs on, the spring that lifts a new arc out of the surface; d < 2√k (≈12.6), so it overshoots. */
const LIFT_K = 40;
const LIFT_D = 5;


interface Arc {
  slot: number;
  flow: Flow;
  end: THREE.Vector3;
  omega: number;
  lift: number;
  liftVel: number;
  age: number;
  activity: number;
  fade: number;
  highlight: number;
  alive: boolean;
  upDue: number;
  downDue: number;
}

/**
 * One arc per remote host, from home to wherever the host is registered. Arcs draw themselves out
 * and spring up when a host first appears, glow with its traffic, and fade when it goes quiet.
 * The arcs are a single draw: a ribbon of SEGMENTS quads per slot whose shape the vertex shader
 * reads from the arc texture, widened in screen space so lines stay crisp at any zoom.
 */
export class Arcs {
  readonly texture: THREE.DataTexture;
  readonly ribbons: THREE.Mesh;
  readonly ends: THREE.Points;
  readonly pulses: Pulses;
  hovered: string | null = null;

  private readonly data = new Float32Array(MAX_ARCS * 3 * 4);
  private readonly arcs = new Map<string, Arc>();
  private readonly free: number[] = [];
  private readonly cooling: { slot: number; until: number }[] = [];
  private readonly home = new THREE.Vector3(0, 0, 1);
  private homeLonLat = { lon: 0, lat: 0 };
  private readonly ribbonMaterial: THREE.ShaderMaterial;
  private readonly endMaterial: THREE.ShaderMaterial;

  /** springs: a new arc's height overshoots and settles, rather than rising as the arc draws out. */
  constructor(private readonly springs: boolean) {
    for (let i = MAX_ARCS - 1; i >= 0; i--) this.free.push(i);
    this.texture = new THREE.DataTexture(this.data, MAX_ARCS, 3, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
    this.pulses = new Pulses(this.texture);

    this.ribbonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uArcs: { value: this.texture },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uWidth: { value: ARC_WIDTH },
        uColor: { value: ARC_COLOR },
        uHot: { value: GREEN },
        uOpacity: { value: ARC_OPACITY },
        uFarSide: farSide,
      },
      vertexShader: /* glsl */ `
        ${ARC_GLSL}
        ${FAR_SIDE_GLSL}
        // position packs (slot, t, side) rather than a point: the shader makes the point.
        uniform vec2 uResolution;
        uniform float uWidth;
        varying float vSide;
        varying float vAlpha;
        varying float vHighlight;
        varying float vShade;
        void main() {
          int i = int(position.x + 0.5);
          vec4 meta = arcMeta(i);
          if (meta.y < 0.002) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // every vertex of the slot lands here: nothing drawn
            return;
          }
          // Vertices past the drawn fraction pile up on its end, so the arc grows out from home.
          float t = min(position.y, meta.x);
          float dt = 1.0 / ${SEGMENTS}.0;
          float t2 = t + dt <= 1.0 ? t + dt : t - dt;
          mat4 mvp = projectionMatrix * modelViewMatrix;
          vec3 p = arcPoint(i, t);
          vec4 c = mvp * vec4(p, 1.0);
          vec4 c2 = mvp * vec4(arcPoint(i, t2), 1.0);
          vec2 d = (c2.xy / c2.w - c.xy / c.w) * uResolution * sign(t2 - t);
          vec2 dir = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
          c.xy += vec2(-dir.y, dir.x) * position.z * uWidth / uResolution * 2.0 * c.w;
          gl_Position = c;
          vSide = position.z;
          vAlpha = meta.y;
          vHighlight = meta.z;
          vShade = farSideShade(p);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform vec3 uHot;
        uniform float uOpacity;
        varying float vSide;
        varying float vAlpha;
        varying float vHighlight;
        varying float vShade;
        void main() {
          float edge = exp(-vSide * vSide * 3.0);
          float a = edge * vAlpha * vShade * (uOpacity + 0.9 * vHighlight);
          gl_FragColor = vec4(mix(uColor, uHot, vHighlight), a);
        }`,
      // The ribbon is built in screen space, so its winding depends on which way the arc runs.
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ribbons = new THREE.Mesh(ribbonGeometry(), this.ribbonMaterial);
    this.ribbons.frustumCulled = false;
    this.ribbons.renderOrder = 2;

    this.endMaterial = new THREE.ShaderMaterial({
      uniforms: { uArcs: { value: this.texture }, uPixelRatio: { value: 1 }, uColor: { value: GREEN }, uFarSide: farSide },
      vertexShader: /* glsl */ `
        ${ARC_GLSL}
        ${FAR_SIDE_GLSL}
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          int i = int(position.x + 0.5);
          vec4 meta = arcMeta(i);
          vec3 end = texelFetch(uArcs, ivec2(i, 1), 0).xyz * 1.003;
          vAlpha = meta.y * smoothstep(0.85, 1.0, meta.x) * (0.6 + 0.6 * meta.z) * farSideShade(end);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(end, 1.0);
          gl_PointSize = vAlpha < 0.002 ? 0.0 : (5.0 + 7.0 * meta.w + 6.0 * meta.z) * uPixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-r * r * 7.0) * vAlpha;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const slots = new Float32Array(MAX_ARCS * 3);
    for (let i = 0; i < MAX_ARCS; i++) slots[i * 3] = i;
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(slots, 3));
    this.ends = new THREE.Points(g, this.endMaterial);
    this.ends.frustumCulled = false;
    this.ends.renderOrder = 3;
  }

  setHome(lon: number, lat: number) {
    if (lon === this.homeLonLat.lon && lat === this.homeLonLat.lat) return;
    this.homeLonLat = { lon, lat };
    lonLatToVec3(lon, lat, 1, this.home);
    for (const arc of this.arcs.values()) this.place(arc);
  }

  /** Takes the latest snapshot: new hosts get arcs, missing ones start to fade. */
  sync(snap: Snapshot) {
    const seen = new Set<string>();
    for (const flow of snap.flows) {
      seen.add(flow.id);
      const arc = this.arcs.get(flow.id);
      if (arc) {
        arc.flow = flow;
        arc.alive = true;
        continue;
      }
      const slot = this.free.pop();
      if (slot === undefined) continue; // full: the host gets an arc once one frees up
      const fresh: Arc = {
        slot,
        flow,
        end: new THREE.Vector3(),
        omega: 0,
        lift: 0,
        liftVel: 0,
        age: 0,
        activity: 0,
        fade: 0,
        highlight: 0,
        alive: true,
        upDue: 0.7, // most of the way to the first pulse, so a new host shows traffic quickly
        downDue: 0.7,
      };
      this.place(fresh);
      this.arcs.set(flow.id, fresh);
    }
    for (const [id, arc] of this.arcs) if (!seen.has(id)) arc.alive = false;
  }

  update(dt: number, time: number, width: number, height: number, pixelRatio: number) {
    for (let i = this.cooling.length - 1; i >= 0; i--) {
      if (time >= this.cooling[i].until) {
        this.free.push(this.cooling[i].slot);
        this.cooling.splice(i, 1);
      }
    }

    const ease = (tau: number) => 1 - Math.exp(-dt / tau);
    for (const [id, arc] of this.arcs) {
      arc.age += dt;
      const grown = 1 - (1 - Math.min(1, arc.age / GROW_TIME)) ** 3;
      if (this.springs) {
        // Semi-implicit Euler is only stable in small steps, and a throttled tab hands us big ones.
        const steps = Math.ceil(dt * 120);
        for (let i = 0; i < steps; i++) {
          const h = dt / steps;
          arc.liftVel += (LIFT_K * (liftFor(arc.omega) - arc.lift) - LIFT_D * arc.liftVel) * h;
          arc.lift += arc.liftVel * h;
        }
      } else {
        arc.lift = liftFor(arc.omega) * grown;
      }

      const rate = arc.flow.up + arc.flow.down;
      const activity = arc.alive ? Math.min(1, Math.log10(1 + rate / 300) / 4) : 0;
      arc.activity += (activity - arc.activity) * ease(0.5);
      arc.fade += ((arc.alive ? 1 : 0) - arc.fade) * ease(arc.alive ? 0.25 : 0.6);
      arc.highlight += ((this.hovered === id ? 1 : 0) - arc.highlight) * ease(0.12);

      if (!arc.alive && arc.fade < 0.01) {
        this.arcs.delete(id);
        this.write(arc.slot, null);
        this.pulses.clearSlot(arc.slot);
        this.cooling.push({ slot: arc.slot, until: time + SLOT_COOLDOWN });
        continue;
      }

      if (arc.alive && arc.age >= GROW_TIME) this.emit(arc, dt, time);
      this.write(arc.slot, arc, grown);
    }
    this.texture.needsUpdate = true;

    this.ribbonMaterial.uniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
    this.ribbonMaterial.uniforms.uWidth.value = ARC_WIDTH * pixelRatio;
    this.endMaterial.uniforms.uPixelRatio.value = pixelRatio;
    this.pulses.update(time, width, height, pixelRatio);
  }

  /**
   * The flow whose endpoint is nearest the pointer, within a few pixels, on the visible side of the
   * globe. Coordinates are CSS pixels relative to the canvas.
   */
  pick(x: number, y: number, camera: THREE.Camera, globe: THREE.Object3D, width: number, height: number): Flow | null {
    const p = new THREE.Vector3();
    const cam = camera.position;
    let best: Flow | null = null;
    let bestDist = 14 * 14;
    for (const arc of this.arcs.values()) {
      if (!arc.alive || arc.age < GROW_TIME) continue;
      p.copy(arc.end).multiplyScalar(1.003).applyMatrix4(globe.matrixWorld);
      if (p.dot(cam) <= p.lengthSq()) continue; // over the horizon
      p.project(camera);
      const dx = ((p.x + 1) / 2) * width - x;
      const dy = ((1 - p.y) / 2) * height - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = arc.flow;
      }
    }
    return best;
  }

  get count() {
    return this.arcs.size;
  }

  /** Spawns this frame's pulses: more of them, and fatter, the busier the host. */
  private emit(arc: Arc, dt: number, time: number) {
    const duration = arc.flow.rtt
      ? clamp(0.7 + arc.flow.rtt / 90, 0.7, 4)
      : clamp(0.9 + arc.omega * 0.8, 0.9, 3.5);
    arc.upDue += pulsesPerSecond(arc.flow.up) * dt;
    arc.downDue += pulsesPerSecond(arc.flow.down) * dt;
    while (arc.upDue >= 1) {
      arc.upDue -= 1;
      this.pulses.spawn(arc.slot, time - Math.random() * dt, duration, 1, pulseSize(arc.flow.up));
    }
    while (arc.downDue >= 1) {
      arc.downDue -= 1;
      this.pulses.spawn(arc.slot, time - Math.random() * dt, duration, -1, pulseSize(arc.flow.down));
    }
  }

  /**
   * Puts the far end of an arc on the map. Hosts are jittered a little so the many addresses one
   * provider registers at a single spot fan out instead of drawing one line; hosts in home's own
   * city are pushed out into a small ring, since an arc of zero length can't be seen.
   */
  private place(arc: Arc) {
    const { flow } = arc;
    let lat = flow.lat + (hash01(flow.id, 1) - 0.5) * 0.8;
    let lon = flow.lon + ((hash01(flow.id, 2) - 0.5) * 0.8) / Math.max(0.2, Math.cos((flow.lat * Math.PI) / 180));
    lonLatToVec3(lon, lat, 1, arc.end);
    const minAngle = THREE.MathUtils.degToRad(1.6);
    if (arc.end.angleTo(this.home) < minAngle) {
      const bearing = hash01(flow.id, 3) * Math.PI * 2;
      const dist = 1.6 + hash01(flow.id, 4) * 1.6;
      const home = this.homeLonLat;
      lat = home.lat + dist * Math.cos(bearing);
      lon = home.lon + (dist * Math.sin(bearing)) / Math.max(0.2, Math.cos((home.lat * Math.PI) / 180));
      lonLatToVec3(lon, lat, 1, arc.end);
    }
    arc.omega = Math.min(arc.end.angleTo(this.home), Math.PI - 1e-3);
  }

  private write(slot: number, arc: Arc | null, grown = 0) {
    const d = this.data;
    const row = (r: number) => (r * MAX_ARCS + slot) * 4;
    if (!arc) {
      d.fill(0, row(2), row(2) + 4);
      return;
    }
    d[row(0)] = this.home.x;
    d[row(0) + 1] = this.home.y;
    d[row(0) + 2] = this.home.z;
    d[row(0) + 3] = Math.max(0, arc.lift);
    d[row(1)] = arc.end.x;
    d[row(1) + 1] = arc.end.y;
    d[row(1) + 2] = arc.end.z;
    d[row(1) + 3] = arc.omega;
    d[row(2)] = grown;
    d[row(2) + 1] = arc.fade * (0.3 + 0.7 * arc.activity);
    d[row(2) + 2] = arc.highlight;
    d[row(2) + 3] = arc.activity;
  }
}

/** Peak height of an arc above the surface: low for neighbours, a tall bow for the far side. */
function liftFor(omega: number) {
  return 0.05 + (0.4 * omega) / Math.PI;
}

/** Pulse rate grows with the log of throughput: about 1/s at 1.5 kB/s, 3/s at 150 kB/s. */
function pulsesPerSecond(bytesPerSec: number) {
  return bytesPerSec < 150 ? 0 : Math.min(7, 1.1 * Math.log10(bytesPerSec / 150));
}

/** Half-width of a pulse in CSS pixels. */
function pulseSize(bytesPerSec: number) {
  return 1.7 + 0.4 * Math.log10(1 + bytesPerSec / 1000);
}

function ribbonGeometry() {
  const perSlot = (SEGMENTS + 1) * 2;
  const pos = new Float32Array(MAX_ARCS * perSlot * 3);
  const index = new Uint32Array(MAX_ARCS * SEGMENTS * 6);
  let v = 0;
  let k = 0;
  for (let slot = 0; slot < MAX_ARCS; slot++) {
    const base = slot * perSlot;
    for (let j = 0; j <= SEGMENTS; j++) {
      for (const side of [-1, 1]) {
        pos[v++] = slot;
        pos[v++] = j / SEGMENTS;
        pos[v++] = side;
      }
      if (j < SEGMENTS) {
        const a = base + j * 2;
        index.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], k);
        k += 6;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
