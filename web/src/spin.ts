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
/** Tilt limits. Past the soft one a drag meets growing resistance; it can't pass the hard one. */
const PITCH_SOFT = 1.05;
const PITCH_HARD = 1.35;
/** Zoom stops, as camera distance from the centre, and the spring that holds them. */
export const DIST_MIN = 1.9;
export const DIST_MAX = 9;
const ZOOM_K = 70;
const ZOOM_D = 11;
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
      this.yaw = this.targetYaw;
      this.pitch = this.targetPitch;
      this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-h / ZOOM_TAU));
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
    this.distVel += (ZOOM_K * (this.targetDist - this.dist) - ZOOM_D * this.distVel) * h;
    this.dist += this.distVel * h;
  }

  private get idleSpin() {
    return this.autospin ? IDLE_SPIN : 0;
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
    this.targetYaw += (e.clientX - this.lastX) * k;
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
    let next = this.targetDist * Math.exp(dy * 0.0012);
    if (!this.springs) {
      this.targetDist = clamp(next, DIST_MIN, DIST_MAX);
      return;
    }
    // Rubber band: past a stop, each notch moves the target a third as far, up to some slack.
    if (next < DIST_MIN) next = Math.max(DIST_MIN - 0.35, this.targetDist + (next - this.targetDist) / 3);
    if (next > DIST_MAX) next = Math.min(DIST_MAX + 1.2, this.targetDist + (next - this.targetDist) / 3);
    this.targetDist = next;
    this.lastWheel = this.clock;
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
