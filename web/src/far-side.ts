/**
 * How brightly the globe's far side shows through it: 0 while the globe is solid. Every material
 * drawn on or around the globe holds this same object as its `uFarSide` uniform, so setting it once
 * changes them all.
 */
export const farSide = { value: 0 };

/**
 * Vertex-shader helper: 1 for a point the camera sees directly, uFarSide for one with the globe in
 * the way. The globe is the unit sphere at the world origin (only its group rotates), so the test
 * is a ray–sphere intersection in world space, and it needs no depth buffer — which a see-through
 * globe can't write.
 */
export const FAR_SIDE_GLSL = /* glsl */ `
  uniform float uFarSide;
  float farSideShade(vec3 local) {
    vec3 world = (modelMatrix * vec4(local, 1.0)).xyz;
    vec3 ray = world - cameraPosition;
    float len = length(ray);
    ray /= len;
    float b = dot(cameraPosition, ray);
    float disc = b * b - dot(cameraPosition, cameraPosition) + 1.0;
    if (disc <= 0.0) return 1.0;
    float enter = -b - sqrt(disc);
    return enter > 0.0 && enter < len - 1e-3 ? uFarSide : 1.0;
  }
`;
