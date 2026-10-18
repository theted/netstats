import * as THREE from 'three';
import type { Flow } from './feed.ts';
import { FAR_SIDE_GLSL, farSide } from './far-side.ts';
import { ACCENT } from './theme.ts';

/** Most places kept; past this the oldest dot is reused. */
const MAX_DOTS = 8192;

/**
 * A faint dot wherever a host has been seen since the page opened, so the globe keeps a map of
 * where traffic went after the arcs have faded. Dots are recorded whether or not they are shown,
 * so turning them on reveals the whole session.
 */
export class Dots {
  readonly points: THREE.Points;
  private readonly position: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly flows: Flow[] = [];
  private readonly index = new Map<string, number>();
  private cursor = 0;

  /** place puts a host where its arc ends, so a dot sits under the arc's end while both show. */
  constructor(private readonly place: (flow: Flow, out: THREE.Vector3) => THREE.Vector3) {
    this.position = new THREE.BufferAttribute(new Float32Array(MAX_DOTS * 3), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry().setAttribute('position', this.position);
    g.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: ACCENT }, uPixelRatio: { value: 1 }, uFarSide: farSide },
      vertexShader: /* glsl */ `
        ${FAR_SIDE_GLSL}
        uniform float uPixelRatio;
        varying float vShade;
        void main() {
          vShade = farSideShade(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 6.0 * uPixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vShade;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = exp(-r * r * 7.0) * 0.8 * vShade;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /** Marks where a host is, once. */
  add(flow: Flow) {
    if (this.index.has(flow.id)) return;
    const i = this.cursor;
    this.cursor = (i + 1) % MAX_DOTS;
    if (this.flows[i]) this.index.delete(this.flows[i].id);
    this.flows[i] = flow;
    this.index.set(flow.id, i);
    this.write(i);
    this.points.geometry.setDrawRange(0, this.flows.length);
  }

  /** Puts every dot back in place, after home has moved and taken the hosts ringed around it along. */
  replace() {
    for (let i = 0; i < this.flows.length; i++) this.write(i);
  }

  update(pixelRatio: number) {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  private write(i: number) {
    const p = this.place(this.flows[i], new THREE.Vector3()).multiplyScalar(1.002);
    this.position.setXYZ(i, p.x, p.y, p.z);
    this.position.needsUpdate = true;
  }
}
