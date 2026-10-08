/**
 * Arc data, one column per slot, read by both the arc and pulse shaders:
 *   row 0: start (home) xyz, peak height above the surface
 *   row 1: end xyz, angle between the ends
 *   row 2: drawn fraction (0–1), opacity, highlight, activity
 */
export const ARC_GLSL = /* glsl */ `
  uniform sampler2D uArcs;
  vec4 arcMeta(int i) { return texelFetch(uArcs, ivec2(i, 2), 0); }
  // The great circle from start to end, lifted by a sine bump that peaks halfway.
  vec3 arcPoint(int i, float t) {
    vec4 s = texelFetch(uArcs, ivec2(i, 0), 0);
    vec4 e = texelFetch(uArcs, ivec2(i, 1), 0);
    vec3 p = e.w < 1e-4 ? s.xyz : (sin((1.0 - t) * e.w) * s.xyz + sin(t * e.w) * e.xyz) / sin(e.w);
    return p * (1.0 + s.w * sin(3.14159265 * t));
  }
`;
