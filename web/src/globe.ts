import * as THREE from 'three';
import { mesh } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import { FAR_SIDE_GLSL, farSide } from './far-side.ts';
import { lonLatToVec3 } from './geo.ts';
import { ACCENT } from './theme.ts';

/**
 * The globe itself: a near-black sphere with a fresnel rim in the accent colour and a faint halo,
 * coastlines, hairline borders, a sparse graticule and a beacon at home. Everything is drawn in the
 * group's frame, so rotating the group turns all of it, arcs included.
 *
 * A solid globe hides its far side with the depth buffer. A translucent one writes no depth, and
 * every material instead dims what lies behind it (see far-side.ts).
 */
export class Globe {
  readonly group = new THREE.Group();
  private readonly home = new THREE.Vector3(0, 0, 1);
  private readonly beacon: THREE.Points;
  private readonly beaconMaterial: THREE.ShaderMaterial;
  private land: THREE.LineSegments[] = [];

  constructor(translucent: boolean) {
    this.group.add(sphere(translucent), halo(), graticule());

    this.beaconMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: ACCENT }, uPixelRatio: { value: 1 }, uFarSide: farSide },
      vertexShader: /* glsl */ `
        ${FAR_SIDE_GLSL}
        uniform float uPixelRatio;
        varying float vShade;
        void main() {
          vShade = farSideShade(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 46.0 * uPixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying float vShade;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float core = exp(-r * r * 160.0);
          // A ring that leaves home every two seconds and fades as it widens.
          float phase = fract(uTime * 0.5);
          float ring = exp(-pow((r - phase) * 18.0, 2.0)) * (1.0 - phase);
          float a = (core * 1.4 + ring * 0.7) * vShade;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 1], 3));
    this.beacon = new THREE.Points(g, this.beaconMaterial);
    this.beacon.renderOrder = 3;
    this.group.add(this.beacon);
  }

  /**
   * Loads coastlines and borders, in place of any loaded before. The globe is usable before they
   * arrive.
   */
  async loadLand(url: string) {
    const topo = (await (await fetch(url)).json()) as Topology<{ countries: GeometryCollection; land: GeometryCollection }>;
    const coast = mesh(topo, topo.objects.land);
    const borders = mesh(topo, topo.objects.countries, (a, b) => a !== b);
    for (const old of this.land) {
      this.group.remove(old);
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
    }
    this.land = [lines(coast.coordinates, 1.0015, 0.42), lines(borders.coordinates, 1.0012, 0.1)];
    this.group.add(...this.land);
  }

  setHome(lon: number, lat: number) {
    lonLatToVec3(lon, lat, 1.004, this.home);
    const pos = this.beacon.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, this.home.x, this.home.y, this.home.z);
    pos.needsUpdate = true;
  }

  update(time: number, pixelRatio: number) {
    this.beaconMaterial.uniforms.uTime.value = time;
    this.beaconMaterial.uniforms.uPixelRatio.value = pixelRatio;
  }
}

/**
 * The body: near black, tinted toward the accent, with the limb lit in the accent colour. Solid,
 * it writes depth and hides everything behind it. Translucent, it writes none, and is drawn first
 * so all the additive lines land on top of it.
 */
function sphere(translucent: boolean) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uRim: { value: ACCENT } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uRim;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float f = 1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0);
        vec3 base = uRim * 0.005;
        gl_FragColor = vec4(base + uRim * pow(f, 4.0) * 0.16, 1.0);
      }`,
    depthWrite: !translucent,
    // Pushed back a hair so lines drawn just above the surface never fight it for depth.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), material);
  body.renderOrder = -1;
  return body;
}

/** A soft glow just outside the limb. */
function halo() {
  const material = new THREE.ShaderMaterial({
    // Its own far-side value, always 0: through a translucent globe the halo's back would wash the
    // whole disc. It only ever glows outside the limb.
    uniforms: { uColor: { value: ACCENT }, uFarSide: { value: 0 } },
    vertexShader: /* glsl */ `
      ${FAR_SIDE_GLSL}
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vShade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vShade = farSideShade(position);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vShade;
      void main() {
        float f = dot(normalize(vNormal), normalize(vView));
        float a = pow(clamp(-f, 0.0, 1.0), 2.5) * 0.1 * vShade;
        gl_FragColor = vec4(uColor, a);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(1.14, 64, 48), material);
}

function lineMaterial(opacity: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: ACCENT }, uOpacity: { value: opacity }, uFarSide: farSide },
    vertexShader: /* glsl */ `
      ${FAR_SIDE_GLSL}
      varying float vShade;
      void main() {
        vShade = farSideShade(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vShade;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity * vShade);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Line strings in lon/lat as segments on the sphere. Long edges are split along the great circle,
 * so a straight run in the data bends with the surface instead of cutting under it.
 */
function lines(strings: number[][][], radius: number, opacity: number) {
  const positions: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (const line of strings) {
    for (let i = 1; i < line.length; i++) {
      lonLatToVec3(line[i - 1][0], line[i - 1][1], 1, a);
      lonLatToVec3(line[i][0], line[i][1], 1, b);
      const steps = Math.max(1, Math.ceil(a.angleTo(b) / THREE.MathUtils.degToRad(2)));
      p.copy(a);
      for (let s = 1; s <= steps; s++) {
        slerpUnit(a, b, s / steps, q);
        positions.push(p.x * radius, p.y * radius, p.z * radius, q.x * radius, q.y * radius, q.z * radius);
        p.copy(q);
      }
    }
  }
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const segs = new THREE.LineSegments(g, lineMaterial(opacity));
  segs.renderOrder = 1;
  return segs;
}

/** Parallels and meridians every 30°, very faint. */
function graticule() {
  const strings: number[][][] = [];
  for (let lat = -60; lat <= 60; lat += 30) {
    const s: number[][] = [];
    for (let lon = -180; lon <= 180; lon += 2) s.push([lon, lat]);
    strings.push(s);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const s: number[][] = [];
    for (let lat = -88; lat <= 88; lat += 2) s.push([lon, lat]);
    strings.push(s);
  }
  return lines(strings, 1.0008, 0.05);
}

function slerpUnit(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) {
  const omega = a.angleTo(b);
  if (omega < 1e-6) return out.copy(a);
  const s = Math.sin(omega);
  return out
    .copy(a)
    .multiplyScalar(Math.sin((1 - t) * omega) / s)
    .addScaledVector(b, Math.sin(t * omega) / s);
}
