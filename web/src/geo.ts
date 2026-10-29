import * as THREE from 'three';

/**
 * The sphere convention, copied from worldtemp's src/geo.ts so the two projects agree: it matches
 * `THREE.SphereGeometry`'s own parameterisation, i.e. the equirectangular projection, with +Y north.
 */
export function lonLatToVec3(lon: number, lat: number, radius: number, out = new THREE.Vector3()) {
  const phi = ((lon + 180) * Math.PI) / 180;
  const theta = ((90 - lat) * Math.PI) / 180;
  const s = Math.sin(theta);
  return out.set(-radius * Math.cos(phi) * s, radius * Math.cos(theta), radius * Math.sin(phi) * s);
}

/**
 * The globe rotation (yaw about +Y, then pitch about +X, as `Euler(pitch, yaw, 0, 'XYZ')`) that
 * turns a lon/lat to face a camera on +Z.
 */
export function facing(lon: number, lat: number): { yaw: number; pitch: number } {
  return { yaw: Math.PI / 2 - ((lon + 180) * Math.PI) / 180, pitch: (lat * Math.PI) / 180 };
}

/** A stable pseudo-random number in [0, 1) for a string, so a host keeps its jitter across frames. */
export function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const EARTH_KM = 6371;

/** Great-circle distance in km: the shortest way round the globe, as a plane would fly it. */
export function kmBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  return lonLatToVec3(a.lon, a.lat, 1).angleTo(lonLatToVec3(b.lon, b.lat, 1)) * EARTH_KM;
}
