/**
 * GestureDetector.js
 *
 * Finite-state machine that converts normalised hand-distance measurements
 * into LED brightness commands.
 *
 * ── States ────────────────────────────────────────────────────────────────
 *
 *  ACTIVE        Normal operation. Brightness tracks hand spread in real time.
 *
 *  OFF           Lights are off. Entered by holding hands together for
 *                CLOSE_HOLD_MS. Exited by spreading hands wider than WAKE_THRESHOLD.
 *
 *  TRACKING_LOST Both hands are not visible. Brightness fades smoothly to zero
 *                at FADE_RATE units per frame. Resumes automatically when
 *                both hands are detected again.
 *
 * ── Transitions ───────────────────────────────────────────────────────────
 *
 *  ACTIVE        → OFF           : normalizedDist < CLOSE_THRESHOLD for ≥ CLOSE_HOLD_MS
 *  ACTIVE        → TRACKING_LOST : !bothHandsVisible
 *  OFF           → ACTIVE        : bothHandsVisible && normalizedDist > WAKE_THRESHOLD
 *  TRACKING_LOST → ACTIVE        : bothHandsVisible
 *
 * ── Brightness mapping ────────────────────────────────────────────────────
 *
 *  Gamma-corrected power curve (γ = 2.0) maps human perception correctly:
 *
 *    brightness = clamp(normDist, 0, 1) ^ 2.0 × 255
 *
 *  Which gives approximately:
 *    20 % distance →  4 % brightness  (≈ 10 / 255)
 *    50 % distance → 25 % brightness  (≈ 64 / 255)
 *   100 % distance → 100 % brightness (= 255 / 255)
 *
 * ── Anti-flicker ─────────────────────────────────────────────────────────
 *
 *  OFF gesture: once fired, the _closeFired flag prevents re-triggering until
 *  hands separate above WAKE_THRESHOLD (full state transition required).
 */

export const GestureState = Object.freeze({
  ACTIVE:        'ACTIVE',
  OFF:           'OFF',
  TRACKING_LOST: 'TRACKING_LOST',
  LOCKED:        'LOCKED',
});

/** Gamma exponent for brightness curve. 2.0 matches human luminance perception. */
const GAMMA = 2.0;

/** Normalised distance below which hands are considered "together". */
const CLOSE_THRESHOLD = 0.14;

/** Normalised distance above which system wakes from OFF. */
const WAKE_THRESHOLD = 0.22;

/** Duration hands must be held together to trigger the OFF gesture (ms). */
const CLOSE_HOLD_MS = 300;

/**
 * Brightness decrease per frame during tracking-loss fade.
 * At 60 fps: 255 → 0 in ≈ 2 seconds.
 */
const FADE_RATE = 2.125;

export class GestureDetector {
  constructor() {
    /** @type {GestureState[keyof GestureState]} */
    this._state = GestureState.TRACKING_LOST;

    /**
     * Timestamp (ms) of when hands first came together.
     * Null when hands are not in the "together" region.
     * @type {number | null}
     */
    this._closeStartedAt = null;

    /**
     * True once the OFF gesture has fired, preventing immediate re-triggering
     * while hands are still within the close region.
     * @type {boolean}
     */
    this._closeFired = false;

    /**
     * Timestamp (ms) of when both thumbs up was first detected.
     * @type {number | null}
     */
    this._thumbsUpStartedAt = null;

    /**
     * True once the lock gesture has fired, preventing immediate re-triggering.
     * @type {boolean}
     */
    this._lockFired = false;

    /**
     * Current brightness value managed by this detector (float, 0–255).
     * Fractional so that fade increments stay accurate across many frames.
     * @type {number}
     */
    this._brightness = 0;

    /**
     * Whether the tracking-loss fade is actively running.
     * @type {boolean}
     */
    this._fading = false;

    // ── Callbacks ──────────────────────────────────────────────────────────
    /**
     * Fired on every state transition.
     * @type {((newState: string, prevState: string) => void) | null}
     */
    this.onStateChange = null;

    /**
     * Fired every frame with the close-gesture hold progress (0–1).
     * Useful for showing a progress indicator in the UI.
     * @type {((progress: number) => void) | null}
     */
    this.onCloseProgress = null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Process one frame of tracking data.
   *
   * @param {{
   *   bothHandsVisible  : boolean,
   *   normalizedDistance: number,
   * }} trackingData
   *
   * @returns {{ brightness: number, state: string }}
   *   brightness – integer [0, 255] representing the desired LED level.
   *   state      – current GestureState.
   */
  process(trackingData) {
    const { bothHandsVisible, normalizedDistance, bothThumbsUp } = trackingData;
    const now = performance.now();

    switch (this._state) {
      case GestureState.ACTIVE:
        return this._handleActive(bothHandsVisible, normalizedDistance, bothThumbsUp, now);

      case GestureState.OFF:
        return this._handleOff(bothHandsVisible, normalizedDistance, bothThumbsUp, now);

      case GestureState.TRACKING_LOST:
        return this._handleTrackingLost(bothHandsVisible, normalizedDistance, bothThumbsUp, now);

      case GestureState.LOCKED:
        return this._handleLocked(bothHandsVisible, bothThumbsUp, now);

      default:
        return { brightness: Math.round(this._brightness), state: this._state };
    }
  }

  /**
   * Imperatively set the brightness value.
   * Used to restore brightness from settings after a reconnect.
   * @param {number} value - Integer [0, 255]
   */
  setBrightness(value) {
    this._brightness = Math.max(0, Math.min(255, value));
  }

  /** Current gesture state. @returns {string} */
  get state() { return this._state; }

  /** Current brightness (float 0–255). @returns {number} */
  get brightness() { return this._brightness; }

  // ─── State handlers ───────────────────────────────────────────────────────

  /**
   * ACTIVE state: normal brightness control.
   * Monitors for the close-hands OFF gesture.
   */
  _handleActive(bothHandsVisible, normalizedDistance, bothThumbsUp, now) {
    // ── Tracking lost? ───────────────────────────────────────────────────
    if (!bothHandsVisible) {
      this._fading = true;
      this._thumbsUpStartedAt = null;
      this._lockFired = false;
      this._transitionTo(GestureState.TRACKING_LOST);
      return { brightness: Math.round(this._brightness), state: this._state };
    }

    this._fading = false;

    // ── Lock gesture detection ───────────────────────────────────────────
    if (bothThumbsUp) {
      if (this._thumbsUpStartedAt === null) {
        this._thumbsUpStartedAt = now;
      }
      if (!this._lockFired && (now - this._thumbsUpStartedAt) >= CLOSE_HOLD_MS) {
        this._lockFired = true;
        this._closeStartedAt = null;
        this._transitionTo(GestureState.LOCKED);
        return { brightness: Math.round(this._brightness), state: this._state };
      }
    } else {
      this._thumbsUpStartedAt = null;
      this._lockFired = false;
    }

    // ── OFF gesture detection ────────────────────────────────────────────
    if (normalizedDistance < CLOSE_THRESHOLD) {
      if (this._closeStartedAt === null) {
        // Arms first entered the close zone — start the timer.
        this._closeStartedAt = now;
      }

      const held = now - this._closeStartedAt;

      // Emit hold progress for optional UI indicator.
      if (this.onCloseProgress) {
        this.onCloseProgress(Math.min(1, held / CLOSE_HOLD_MS));
      }

      if (!this._closeFired && held >= CLOSE_HOLD_MS) {
        // Gesture confirmed → go to OFF.
        this._closeFired  = true;
        this._brightness  = 0;
        this._transitionTo(GestureState.OFF);
        if (this.onCloseProgress) this.onCloseProgress(0);
        return { brightness: 0, state: this._state };
      }
    } else {
      // Hands separated — reset close-gesture timer.
      this._closeStartedAt = null;
      this._closeFired     = false;
      if (this.onCloseProgress) this.onCloseProgress(0);
    }

    // ── Normal brightness mapping ────────────────────────────────────────
    this._brightness = this._gammaToBrightness(normalizedDistance);
    return { brightness: Math.round(this._brightness), state: this._state };
  }

  /**
   * OFF state: lights are off.
   * Waits for hands to spread apart to wake up.
   */
  _handleOff(bothHandsVisible, normalizedDistance, bothThumbsUp, now) {
    this._brightness = 0;

    if (bothHandsVisible && normalizedDistance > WAKE_THRESHOLD) {
      this._closeStartedAt = null;
      this._closeFired     = false;
      this._transitionTo(GestureState.ACTIVE);
      // Set initial brightness to match the current hand position.
      this._brightness = this._gammaToBrightness(normalizedDistance);
    }

    return { brightness: 0, state: this._state };
  }

  /**
   * TRACKING_LOST state: fade brightness toward zero.
   * Returns to ACTIVE when both hands reappear.
   */
  _handleTrackingLost(bothHandsVisible, normalizedDistance, bothThumbsUp, now) {
    // Fade brightness smoothly to zero.
    if (this._fading && this._brightness > 0) {
      this._brightness = Math.max(0, this._brightness - FADE_RATE);
    }

    // Resume when tracking is restored.
    if (bothHandsVisible) {
      this._fading         = false;
      this._closeStartedAt = null;
      this._closeFired     = false;
      this._transitionTo(GestureState.ACTIVE);
      this._brightness = this._gammaToBrightness(normalizedDistance);
    }

    return { brightness: Math.round(this._brightness), state: this._state };
  }

  /**
   * LOCKED state: brightness remains constant.
   * Unlocks when both thumbs up is detected again.
   */
  _handleLocked(bothHandsVisible, bothThumbsUp, now) {
    if (bothThumbsUp) {
      if (this._thumbsUpStartedAt === null) {
        this._thumbsUpStartedAt = now;
      }
      if (!this._lockFired && (now - this._thumbsUpStartedAt) >= CLOSE_HOLD_MS) {
        this._lockFired = true;
        this._transitionTo(bothHandsVisible ? GestureState.ACTIVE : GestureState.TRACKING_LOST);
      }
    } else {
      this._thumbsUpStartedAt = null;
      this._lockFired = false;
    }

    return { brightness: Math.round(this._brightness), state: this._state };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Convert a normalised hand distance [0, 1] to a brightness value [0, 255]
   * using a gamma power curve.
   *
   * γ = 2.0 produces:
   *   0.20 → 0.04 × 255 ≈  10
   *   0.50 → 0.25 × 255 ≈  64
   *   1.00 → 1.00 × 255 = 255
   *
   * @param {number} normDist - Clamped to [0, 1] internally.
   * @returns {number} Float brightness in [0, 255].
   */
  _gammaToBrightness(normDist) {
    const clamped = Math.max(0, Math.min(1, normDist));
    return Math.pow(clamped, GAMMA) * 255;
  }

  /**
   * Transition to a new state.
   * No-op if already in that state.
   * Fires onStateChange callback.
   *
   * @param {string} next
   */
  _transitionTo(next) {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    console.info(`[GestureDetector] ${prev} → ${next}`);
    if (this.onStateChange) this.onStateChange(next, prev);
  }
}
