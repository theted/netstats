/**
 * How far arcs have turned into flight paths: 0 draws each as a bow, 1 as the low route a plane
 * would fly. Every material that includes ARC_GLSL holds this same object as its uFlight uniform.
 */
export const flightPath = { value: 0 };

/** A flight path climbs to cruising height over this angle (about 450 km), and descends over it. */
const CLIMB = 0.07;

/**
 * Arc data, one column per slot, read by both the arc and pulse shaders:
 *   row 0: start (home) xyz, how far the arc has risen (1 at rest; springs overshoot it)
 *   row 1: end xyz, angle between the ends
 *   row 2: drawn fraction (0–1), opacity, highlight, activity
 */
export const ARC_GLSL = /* glsl */ `
  uniform sampler2D uArcs;
  uniform float uFlight;
  vec4 arcMeta(int i) { return texelFetch(uArcs, ivec2(i, 2), 0); }
  // Height above the ground at t along an arc spanning angle w. A bow peaks halfway: low between
  // neighbours, tall to the far side. A flight path climbs, holds its cruising height, and comes
  // down at the end, cruising a little higher on a longer route.
  float arcHeight(float t, float w) {
    float bow = (0.05 + 0.4 * w / 3.14159265) * sin(3.14159265 * t);
    float ramp = min(0.5, ${CLIMB.toFixed(3)} / max(w, 1e-4));
    float cruise = 0.012 + 0.018 * smoothstep(0.0, 1.5, w);
    float flight = cruise * smoothstep(0.0, ramp, t) * smoothstep(0.0, ramp, 1.0 - t);
    return mix(bow, flight, uFlight);
  }
  // The great circle from start to end, the shortest way round, lifted off the ground.
  vec3 arcPoint(int i, float t) {
    vec4 s = texelFetch(uArcs, ivec2(i, 0), 0);
    vec4 e = texelFetch(uArcs, ivec2(i, 1), 0);
    vec3 p = e.w < 1e-4 ? s.xyz : (sin((1.0 - t) * e.w) * s.xyz + sin(t * e.w) * e.xyz) / sin(e.w);
    return p * (1.0 + s.w * arcHeight(t, e.w));
  }
`;
