/**
 * EMAFilter.js
 *
 * Exponential Moving Average (EMA) filter for smooth signal transitions.
 *
 * Formula (per sample):
 *   output = α × input + (1 − α) × previous_output
 *
 * Characteristics:
 *   α → 0 : very smooth, but responds slowly (high lag)
 *   α → 1 : very responsive, but noisy (low smoothing)
 *
 * Recommended values:
 *   0.08 – 0.12  →  medium smoothing (good for brightness control)
 *   0.20 – 0.35  →  light smoothing (good for visual gauge animation)
 */
export class EMAFilter {
  /**
   * @param {number} alpha         - Smoothing factor in (0, 1]. Default: 0.12
   * @param {number} initialValue  - Starting value before first sample.
   */
  constructor(alpha = 0.12, initialValue = 0) {
    if (alpha <= 0 || alpha > 1) {
      throw new RangeError(`EMAFilter: alpha must be in (0, 1], got ${alpha}`);
    }
    /** @private */
    this._alpha = alpha;
    /** @private */
    this._value = initialValue;
    /** @private */
    this._seeded = false;
  }

  /**
   * Feed a new raw sample and return the smoothed output.
   *
   * On the very first call the filter "seeds" itself to the input value,
   * avoiding the slow ramp-up from the arbitrary initial value.
   *
   * @param {number} input - New raw measurement
   * @returns {number}      Smoothed value
   */
  update(input) {
    if (!this._seeded) {
      this._value = input;
      this._seeded = true;
    } else {
      this._value = this._alpha * input + (1 - this._alpha) * this._value;
    }
    return this._value;
  }

  /**
   * Instantly snap the filter to a given value, bypassing smoothing.
   *
   * Use when a hard state transition occurs (e.g., lights turned OFF,
   * gesture reset) so the filter does not linger at the old value.
   *
   * @param {number} value
   */
  reset(value) {
    this._value = value;
    this._seeded = true;
  }

  /**
   * The current smoothed output without consuming a new sample.
   * @returns {number}
   */
  get value() {
    return this._value;
  }

  /**
   * Update the smoothing factor at runtime.
   * @param {number} alpha
   */
  setAlpha(alpha) {
    if (alpha <= 0 || alpha > 1) {
      throw new RangeError(`EMAFilter: alpha must be in (0, 1], got ${alpha}`);
    }
    this._alpha = alpha;
  }
}
