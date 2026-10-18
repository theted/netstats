/**
 * The globe's rotation and zoom.
 *
 * The pointer moves a *target*. A fling hands its velocity to the target, which then relaxes back
 * to the idle spin. What happens between target and globe depends on `springs`:
 *
 * - off: the globe follows the target exactly, so the point under the cursor stays under it. Tilt
 *   stays where it is left, zoom eases without overshoot, and the home key glides there.
 * - on: the globe chases the target through an underdamped spring, so it trails a drag slightly and
 *   overshoots a little when the drag stops. The tilt springs back to rest with a small bounce, and
 *   zoom runs into soft stops and is pulled back from them. (OrbitControls damps by exponential
 *   decay, which can glide but can never overshoot; that is why this is hand-rolled.)
 *
 * The wheel zooms toward the point under the cursor, as a map does, so a city can be zoomed into
 * from the whole globe.
 */

/** Idle spin in radians per second: one turn every two minutes. */
const IDLE_SPIN = 0.052;
/** Following a moving target: k and d with d < 2√k, so it overshoots. */
const FOLLOW_K = 180;
const FOLLOW_D = 17;
/** Returning the tilt to rest: softer, and further below critical damping (2√40 ≈ 12.6). */
const TILT_K = 40;
const TILT_D = 7.5;
/** How fast a fling decays back to the idle spin, in seconds. */
const FLING_TAU = 1.4;
const MAX_FLING = 7;
/**
 * Tilt limits. Past the soft one a drag meets growing resistance; it can't pass the hard one. Both
 * stop short of the pole (π/2), so a city as far north as Tromsø can still be turned to face us.
 */
const PITCH_SOFT = 1.4;
const PITCH_HARD = 1.52;
/**
 * Zoom stops, as camera distance from the centre (the globe's radius is 1), and the spring that
 * holds them. At the closest the view is about 230 km tall: a city and the country around it.
 */
export const DIST_MIN = 1.05;
export const DIST_MAX = 9;
const ZOOM_K = 70;
const ZOOM_D = 11;
/**
 * Zoom per pixel of wheel travel. It scales the height above the ground, so every notch feels the
 * same, high or low.
 */
const ZOOM_RATE = 0.0015;
/**
 * Below this height above the ground the idle spin slows in step with the height, so up close the
 * map drifts by at the same pace on screen.
 */
const SPIN_HEIGHT = 0.9;
/** Without springs: the zoom's easing time constant, and how long the home key's glide takes. */
const ZOOM_TAU = 0.12;
const GLIDE_TIME = 0.9;
/** Pointer samples older than this don't count toward a fling. */
const FLING_WINDOW = 0.08;

interface Glide {
  fromYaw: number;
  toYaw: number;
  fromPitch: number;
  toPitch: number;
  t: number;
}

interface Sample {
  t: number;
  yaw: number;
  pitch: number;
}

type Vec3 = [number, number, number];

/** A point of the globe kept under the cursor while a zoom eases in. */
interface Anchor {
  /** The point, in the globe's own frame. */
  local: Vec3;
  /** The cursor, in normalised device coordinates. */
  x: number;
  y: number;
}

export class Spin {
  yaw: number;
  pitch: number;
  dist: number;
  /** Whether the globe turns by itself when left alone. Switching it eases the spin in or out. */
  autospin = true;

  private yawVel = 0;
  private pitchVel = 0;
  private distVel = 0;

  private targetYaw: number;
  private targetPitch: number;
  private targetDist: number;
  private targetYawVel = IDLE_SPIN;
  private restPitch: number;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private samples: Sample[] = [];
  private lastWheel = -Infinity;
  private clock = 0;
  private glide: Glide | null = null;
  private anchor: Anchor | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly fov: number,
    view: { yaw: number; pitch: number; dist: number },
    private readonly springs: boolean,
  ) {
    this.yaw = this.targetYaw = view.yaw;
    this.pitch = this.targetPitch = this.restPitch = view.pitch;
    this.dist = this.targetDist = view.dist;

    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get isDragging() {
    return this.dragging;
  }

  /** Turns the globe to a new view, keeping the yaw the shortest way round. */
  lookAt(view: { yaw: number; pitch: number }) {
    const turn = view.yaw - this.targetYaw;
    const toYaw = this.targetYaw + turn - 2 * Math.PI * Math.round(turn / (2 * Math.PI));
    const toPitch = clamp(view.pitch, -PITCH_SOFT, PITCH_SOFT);
    this.targetYawVel = this.idleSpin;
    this.anchor = null;
    if (this.springs) {
      this.targetYaw = toYaw;
      this.restPitch = this.targetPitch = toPitch;
    } else {
      this.glide = { fromYaw: this.targetYaw, toYaw, fromPitch: this.targetPitch, toPitch, t: 0 };
    }
  }

  /** Jumps straight to a view with no animation. */
  jumpTo(view: { yaw: number; pitch: number }) {
    this.yaw = this.targetYaw = view.yaw;
    this.pitch = this.targetPitch = this.restPitch = clamp(view.pitch, -PITCH_SOFT, PITCH_SOFT);
    this.yawVel = this.pitchVel = 0;
    this.targetYawVel = this.idleSpin;
    this.glide = null;
    this.anchor = null;
  }

  /** The distance at which the globe, with room for its arcs, fills the shorter side of the view. */
  setFramedDistance(dist: number) {
    this.targetDist = clamp(dist, DIST_MIN, DIST_MAX);
  }

  update(dt: number) {
    // Springs integrated with semi-implicit Euler are only stable for small steps, and a frame can
    // be long after a hidden tab comes back, so split it.
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.step(h);
  }

  private step(h: number) {
    this.clock += h;

    if (this.glide && !this.dragging) {
      const g = this.glide;
      g.t = Math.min(1, g.t + h / GLIDE_TIME);
      const e = g.t * g.t * (3 - 2 * g.t);
      this.targetYaw = g.fromYaw + (g.toYaw - g.fromYaw) * e;
      this.targetPitch = g.fromPitch + (g.toPitch - g.fromPitch) * e;
      if (g.t >= 1) this.glide = null;
    } else if (!this.dragging) {
      this.targetYawVel += (this.idleSpin - this.targetYawVel) * (1 - Math.exp(-h / FLING_TAU));
      this.targetYaw += this.targetYawVel * h;
    }

    if (!this.springs) {
      this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-h / ZOOM_TAU));
      if (this.anchor && !this.dragging) {
        this.hold(this.anchor, this.dist);
        if (Math.abs(this.targetDist - this.dist) < 1e-4 * (this.dist - 1)) this.anchor = null;
      }
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
      return;
    }

    this.yawVel += (FOLLOW_K * (this.targetYaw - this.yaw) - FOLLOW_D * this.yawVel) * h;
    this.yaw += this.yawVel * h;

    const [k, d] = this.dragging ? [FOLLOW_K, FOLLOW_D] : [TILT_K, TILT_D];
    const pitchTarget = this.dragging ? this.targetPitch : this.restPitch;
    this.pitchVel += (k * (pitchTarget - this.pitch) - d * this.pitchVel) * h;
    this.pitch = clamp(this.pitch + this.pitchVel * h, -PITCH_HARD, PITCH_HARD);

    // A wheel gesture may push the target past a stop; once it pauses, the stop pulls it back.
    if (this.clock - this.lastWheel > 0.15) this.targetDist = clamp(this.targetDist, DIST_MIN, DIST_MAX);
    // The spring works on the log of the height, so an overshoot is a share of the height and can
    // never carry the camera into the ground.
    const z = Math.log(this.dist - 1);
    this.distVel += (ZOOM_K * (Math.log(this.targetDist - 1) - z) - ZOOM_D * this.distVel) * h;
    this.dist = 1 + Math.exp(z + this.distVel * h);
  }

  private get idleSpin() {
    return this.autospin ? IDLE_SPIN * Math.min(1, (this.dist - 1) / SPIN_HEIGHT) : 0;
  }

  /**
   * Where the ray through a point of the screen, in normalised device coordinates, first meets the
   * globe, with the camera at dist. The camera sits on +Z looking at the centre, so its frame is
   * the world's. Null if the ray misses.
   */
  private hit(x: number, y: number, dist: number): Vec3 | null {
    const t = Math.tan(((this.fov / 2) * Math.PI) / 180);
    const aspect = this.el.clientWidth / Math.max(this.el.clientHeight, 1);
    const d: Vec3 = [x * t * aspect, y * t, -1];
    const n = Math.hypot(...d);
    const b = (dist * d[2]) / n;
    const disc = b * b - dist * dist + 1;
    if (disc < 0) return null;
    const s = (-b - Math.sqrt(disc)) / n;
    return [d[0] * s, d[1] * s, dist + d[2] * s];
  }

  /** Turns the globe so the anchor's point is under its cursor again, with the camera at dist. */
  private hold(anchor: Anchor, dist: number) {
    const q = this.hit(anchor.x, anchor.y, dist);
    const turn = q && turnTo(anchor.local, q, this.targetYaw, this.targetPitch);
    if (!turn) return; // the cursor is off the globe from here: zoom toward the centre
    this.targetYaw = turn.yaw;
    this.targetPitch = clamp(turn.pitch, -PITCH_SOFT, PITCH_SOFT);
  }

  /** Radians of rotation per pixel of drag, so the point under the cursor stays under it. */
  private radPerPx() {
    const halfFov = ((this.fov / 2) * Math.PI) / 180;
    return (2 * (this.dist - 1) * Math.tan(halfFov)) / Math.max(this.el.clientHeight, 1);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events have no live pointer to capture
    }
    this.dragging = true;
    this.glide = null;
    this.anchor = null;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    // Grab the globe where it is now, not where the spring was taking it.
    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;
    this.samples = [{ t: this.clock, yaw: this.targetYaw, pitch: this.targetPitch }];
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const k = this.radPerPx();
    // Yaw turns about the poles, so at the latitude in view the ground moves cos(pitch) as far.
    this.targetYaw += ((e.clientX - this.lastX) * k) / Math.max(Math.cos(this.pitch), 0.2);
    const dPitch = (e.clientY - this.lastY) * k;
    this.targetPitch = this.springs
      ? this.targetPitch + this.resist(this.targetPitch, dPitch)
      : clamp(this.targetPitch + dPitch, -PITCH_SOFT, PITCH_SOFT);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.samples.push({ t: this.clock, yaw: this.targetYaw, pitch: this.targetPitch });
    while (this.samples.length > 2 && this.clock - this.samples[0].t > FLING_WINDOW) this.samples.shift();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    this.dragging = false;
    const first = this.samples[0];
    const span = this.clock - first.t;
    if (span > 1e-3 && this.clock - this.samples[this.samples.length - 1].t < FLING_WINDOW) {
      this.targetYawVel = clamp((this.targetYaw - first.yaw) / span, -MAX_FLING, MAX_FLING);
      this.pitchVel += clamp((this.targetPitch - first.pitch) / span, -MAX_FLING, MAX_FLING) * 0.5;
    } else {
      this.targetYawVel = 0; // let go without flinging: rest, then drift back up to any idle spin
    }
  };

  /** Scales a tilt step down as it pushes further past the soft limit. */
  private resist(pitch: number, delta: number) {
    const over = Math.abs(pitch) - PITCH_SOFT;
    if (over <= 0 || Math.sign(delta) !== Math.sign(pitch)) return delta;
    return delta * Math.max(0, 1 - over / (PITCH_HARD - PITCH_SOFT));
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    let next = 1 + (this.targetDist - 1) * Math.exp(dy * ZOOM_RATE);
    const r = this.el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = 1 - ((e.clientY - r.top) / r.height) * 2;
    if (!this.springs) {
      // Take hold of what is under the cursor now; each step of the zoom turns it back under.
      const q = this.hit(x, y, this.dist);
      this.anchor = q && { local: toGlobe(q, this.yaw, this.pitch), x, y };
      if (this.anchor) this.glide = null;
      this.targetDist = clamp(next, DIST_MIN, DIST_MAX);
      return;
    }
    // With springs the globe trails its target, so turn the target once, to where the zoom ends.
    const q = this.hit(x, y, this.targetDist);
    // Rubber band: past a stop, each notch moves the target a third as far, up to some slack.
    if (next < DIST_MIN) next = Math.max(1 + (DIST_MIN - 1) * 0.6, this.targetDist + (next - this.targetDist) / 3);
    if (next > DIST_MAX) next = Math.min(DIST_MAX + 1.2, this.targetDist + (next - this.targetDist) / 3);
    this.targetDist = next;
    this.lastWheel = this.clock;
    if (q) {
      this.hold({ local: toGlobe(q, this.targetYaw, this.restPitch), x, y }, clamp(next, DIST_MIN, DIST_MAX));
      this.restPitch = this.targetPitch;
    }
  };
}

/**
 * A point in view back in the globe's own frame. The globe is turned by Euler(pitch, yaw, 0), which
 * is the pitch about X applied after the yaw about Y; this undoes both.
 */
function toGlobe([x, y, z]: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y1 = y * cp + z * sp;
  const z1 = -y * sp + z * cp;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return [x * cy - z1 * sy, y1, x * sy + z1 * cy];
}

/**
 * The yaw and pitch that turn point p of the globe to point q in view, nearest the given ones.
 * The yaw has to bring p's x to q's x, since the pitch leaves x alone; that leaves two choices,
 * and the pitch then follows from each. Null if no yaw can, which happens only near the poles.
 */
function turnTo(p: Vec3, q: Vec3, yaw: number, pitch: number) {
  const rho = Math.hypot(p[0], p[2]);
  if (rho < 1e-9 || Math.abs(q[0]) > rho) return null;
  const alpha = Math.atan2(p[2], p[0]);
  const spread = Math.acos(q[0] / rho);
  let best: { yaw: number; pitch: number } | null = null;
  let cost = Infinity;
  for (const theta of [alpha - spread, alpha + spread]) {
    // Ry(theta) maps p's x to rho·cos(alpha - theta) = q's x; its z is what the pitch then turns.
    const rz = -p[0] * Math.sin(theta) + p[2] * Math.cos(theta);
    const turn = {
      yaw: yaw + wrap(theta - yaw),
      pitch: wrap(Math.atan2(q[2], q[1]) - Math.atan2(rz, p[1])),
    };
    const c = Math.abs(turn.yaw - yaw) + Math.abs(turn.pitch - pitch);
    if (c < cost) {
      cost = c;
      best = turn;
    }
  }
  return best;
}

/** An angle brought into (-π, π]. */
function wrap(a: number) {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
