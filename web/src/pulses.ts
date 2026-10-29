import * as THREE from 'three';
import { ARC_GLSL, flightPath } from './arc-shader.ts';
import { FAR_SIDE_GLSL, farSide } from './far-side.ts';
import { DOWN_COLOR, UP_COLOR } from './theme.ts';

/** How many pulses can be in flight at once; the oldest slot is reused when it runs out. */
const POOL = 4096;
/** Length of a pulse's tail, as a fraction of its arc. */
const TAIL = 0.13;

/**
 * Glowing streaks travelling along arcs: outward for upload, homeward for download.
 *
 * All of them are one instanced draw. Each instance only records which arc it rides, when it
 * left, how long the trip takes and which way it goes; the vertex shader reads the arc's current
 * shape from the shared arc texture and works out where the head and tail are this frame. So a pulse
 * follows its arc even while the arc is still springing up out of the surface.
 */
export class Pulses {
  readonly mesh: THREE.Mesh;
  private readonly trip: THREE.InstancedBufferAttribute; // arc slot, departure, duration, direction
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;
  private dirty = false;

  constructor(arcTexture: THREE.Texture) {
    const g = new THREE.InstancedBufferGeometry();
    // Corners of the streak's quad: x runs tail (0) to head (1), y across (-1 to 1).
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const trip = new Float32Array(POOL * 4);
    for (let i = 0; i < POOL; i++) trip[i * 4] = -1; // unused
    this.trip = new THREE.InstancedBufferAttribute(trip, 4);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1);
    this.trip.setUsage(THREE.DynamicDrawUsage);
    this.size.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aTrip', this.trip);
    g.setAttribute('aSize', this.size);
    g.instanceCount = POOL;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uArcs: { value: arcTexture },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPixelRatio: { value: 1 },
        uTail: { value: TAIL },
        uUp: { value: UP_COLOR },
        uDown: { value: DOWN_COLOR },
        uFarSide: farSide,
        uFlight: flightPath,
      },
      vertexShader: /* glsl */ `
        ${ARC_GLSL}
        ${FAR_SIDE_GLSL}
        attribute vec4 aTrip;
        attribute float aSize;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform float uPixelRatio;
        uniform float uTail;
        varying float vAlong;
        varying float vAcross;
        varying float vLength;
        varying float vWidth;
        varying float vAlpha;
        varying float vUp;

        vec2 toPixels(vec4 clip) { return clip.xy / clip.w * 0.5 * uResolution; }

        void main() {
          float age = (uTime - aTrip.y) / aTrip.z;
          if (aTrip.x < 0.0 || age <= 0.0 || age >= 1.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          int i = int(aTrip.x + 0.5);
          vec4 meta = arcMeta(i);
          float head = aTrip.w > 0.0 ? age : 1.0 - age;
          float tail = clamp(head - aTrip.w * uTail, 0.0, 1.0);
          mat4 mvp = projectionMatrix * modelViewMatrix;
          vec3 headPoint = arcPoint(i, head);
          vec4 cHead = mvp * vec4(headPoint, 1.0);
          vec4 cTail = mvp * vec4(arcPoint(i, tail), 1.0);
          vec2 pHead = toPixels(cHead);
          vec2 pTail = toPixels(cTail);
          vec2 d = pHead - pTail;
          float len = length(d);
          vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0);
          vec2 nrm = vec2(-dir.y, dir.x);
          float w = aSize * uPixelRatio;

          // Stretch the quad from just behind the tail to just past the head.
          float along = mix(-w, len + w, position.x);
          vec2 p = pTail + dir * along + nrm * position.y * w;
          vec4 c = mix(cTail, cHead, clamp(along / max(len, 1e-3), 0.0, 1.0));
          gl_Position = vec4(p / (0.5 * uResolution) * c.w, c.z, c.w);

          vAlong = along;
          vAcross = position.y * w;
          vLength = len;
          vWidth = w;
          vAlpha = meta.y * smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.88, 1.0, age)) * farSideShade(headPoint);
          vUp = aTrip.w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uUp;
        uniform vec3 uDown;
        varying float vAlong;
        varying float vAcross;
        varying float vLength;
        varying float vWidth;
        varying float vAlpha;
        varying float vUp;
        void main() {
          // Distance to the tail→head segment, in widths: a capsule with a gaussian edge.
          float outside = vAlong < 0.0 ? -vAlong : max(vAlong - vLength, 0.0);
          float d = length(vec2(outside, vAcross)) / vWidth;
          float core = exp(-d * d * 3.5);
          float toward = clamp(vAlong / max(vLength, 1.0), 0.0, 1.0);
          float a = core * mix(0.08, 1.0, toward * toward) * vAlpha;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vUp > 0.0 ? uUp : uDown, a);
        }`,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; // positions only exist in the shader
    this.mesh.renderOrder = 4;
  }

  /** Sends a pulse along an arc slot: dir 1 runs home → remote (upload), -1 remote → home. */
  spawn(slot: number, time: number, duration: number, dir: 1 | -1, size: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % POOL;
    this.trip.setXYZW(i, slot, time, duration, dir);
    this.size.setX(i, size);
    this.dirty = true;
  }

  /** Forgets every pulse riding a slot, so a reused slot doesn't inherit stragglers. */
  clearSlot(slot: number) {
    const a = this.trip.array as Float32Array;
    for (let i = 0; i < POOL; i++) {
      if (a[i * 4] === slot) {
        a[i * 4] = -1;
        this.dirty = true;
      }
    }
  }

  update(time: number, width: number, height: number, pixelRatio: number) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uResolution.value.set(width * pixelRatio, height * pixelRatio);
    u.uPixelRatio.value = pixelRatio;
    if (this.dirty) {
      this.trip.needsUpdate = true;
      this.size.needsUpdate = true;
      this.dirty = false;
    }
  }
}
