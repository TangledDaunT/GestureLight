/**
 * Diagnostics.js
 *
 * Manages debug mode detection and lightweight diagnostic logging.
 *
 * Debug mode activates when the URL contains `?debug=true`.
 * All debug output is strictly gated — nothing leaks into production paths.
 *
 * Usage:
 *   const diag = new Diagnostics();
 *   if (diag.isDebugEnabled) { ... }
 *   diag.log('some value:', 42);
 */
export class Diagnostics {
  constructor() {
    const params = new URLSearchParams(window.location.search);
    /** @type {boolean} */
    this._enabled = params.get('debug') === 'true';

    if (this._enabled) {
      console.info(
        '%c[GestureLight Debug] Debug mode active.',
        'color:#a78bfa; font-weight:600;'
      );
    }
  }

  /**
   * Whether debug mode is currently active.
   * @returns {boolean}
   */
  get isDebugEnabled() {
    return this._enabled;
  }

  /**
   * Emit a debug-gated console.debug message.
   * No-op in production (debug=false).
   * @param {...unknown} args
   */
  log(...args) {
    if (this._enabled) {
      console.debug('[GestureLight]', ...args);
    }
  }

  /**
   * Emit a debug-gated console.warn message.
   * @param {...unknown} args
   */
  warn(...args) {
    if (this._enabled) {
      console.warn('[GestureLight]', ...args);
    }
  }
}
