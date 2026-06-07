/**
 * DeviceComm.js
 *
 * Manages all communication with the ESP32 LED controller.
 *
 * Transport strategy
 * ──────────────────
 *  Primary   : WebSocket  ws://{ip}/ws
 *  Fallback  : HTTP POST  http://{ip}/api/cmd
 *
 * The class tries WebSocket first. After WS_FAILURE_THRESHOLD consecutive
 * failures it promotes HTTP fallback as the active transport. It continues
 * attempting WebSocket reconnects in the background (with exponential
 * back-off). Once a WebSocket connects successfully it becomes primary again.
 *
 * Throttle & delta filter
 * ────────────────────────
 *  • Commands are sent at most once every SEND_INTERVAL_MS (20 Hz cap).
 *  • A command is only sent if the new brightness differs from the last
 *    sent value by at least DELTA_THRESHOLD units (avoids redundant traffic).
 *
 * Reconnect after connect
 * ───────────────────────
 *  When a WS connection is established the last-known brightness is restored
 *  by the caller via onStatusChange('connected-ws').
 */

/** Maximum send rate: 20 Hz → 50 ms between commands. */
const SEND_INTERVAL_MS = 50;

/**
 * Minimum brightness change (0–255) required before sending a new command.
 * Prevents redundant network traffic for imperceptible changes.
 */
const DELTA_THRESHOLD = 2;

/** Initial WebSocket reconnect delay in ms. */
const WS_BACKOFF_INITIAL_MS = 1_000;

/** Maximum WebSocket reconnect delay in ms. */
const WS_BACKOFF_MAX_MS = 30_000;

/** Multiply delay by this factor after each failure. */
const WS_BACKOFF_MULTIPLIER = 2;

/**
 * Number of consecutive WS failures before switching transport to HTTP.
 * WS reconnect still continues in the background.
 */
const WS_FAILURE_THRESHOLD = 3;

/** Interval between keep-alive pings when WS is open. */
const WS_PING_INTERVAL_MS = 15_000;

/** HTTP fetch timeout in ms. */
const HTTP_TIMEOUT_MS = 3_000;

export class DeviceComm {
  /**
   * @param {string} ip - ESP32 IP address or hostname.
   */
  constructor(ip) {
    /** @type {string} */
    this._ip = ip;

    /** @type {WebSocket | null} */
    this._ws = null;

    /**
     * Active transport mode.
     * @type {'websocket' | 'http' | 'disconnected'}
     */
    this._mode = 'disconnected';

    /** Consecutive WebSocket failure count. */
    this._failCount = 0;

    /** Current back-off delay (increases after each failure). */
    this._backoffMs = WS_BACKOFF_INITIAL_MS;

    /** Whether a reconnect attempt is scheduled. */
    this._reconnecting = false;

    /** Reconnect timer handle. */
    this._reconnectTimer = null;

    /** Ping timer handle. */
    this._pingTimer = null;

    /** Timestamp of the last outgoing ping (for latency calculation). */
    this._pingSentAt = null;

    /** Most recently measured WS round-trip latency in ms. */
    this._wsLatencyMs = null;

    /** Last brightness value actually dispatched to the device. */
    this._lastSentValue = -1;

    /** Timestamp of the last dispatched command. */
    this._lastSentTime = 0;

    /** Brightness value queued for the next throttled send. */
    this._queuedValue = null;

    /** setTimeout handle for throttled send. */
    this._flushTimer = null;

    /** Prevents any activity after destroy(). */
    this._destroyed = false;

    // ── Public callbacks ────────────────────────────────────────────────────
    /**
     * Fired whenever the connection status changes.
     * @type {((status: 'connecting'|'connected-ws'|'http-fallback'|'reconnecting'|'http-error'|'disconnected') => void) | null}
     */
    this.onStatusChange = null;

    /**
     * Fired whenever a new WS latency measurement is available.
     * @type {((latencyMs: number) => void) | null}
     */
    this.onLatencyUpdate = null;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Begin connecting to the device.
   * Safe to call multiple times — subsequent calls are no-ops if already
   * connected or reconnecting.
   */
  connect() {
    if (this._destroyed) return;
    this._openWebSocket();
  }

  /**
   * Switch to a different device address and reconnect immediately.
   * @param {string} ip
   */
  setIP(ip) {
    if (this._destroyed) return;
    this._ip = ip;
    this._teardownWS();
    this._failCount = 0;
    this._backoffMs = WS_BACKOFF_INITIAL_MS;
    this._mode = 'disconnected';
    this._openWebSocket();
  }

  /**
   * Queue a brightness command for the device.
   *
   * The command is throttled to SEND_INTERVAL_MS and deduplicated via
   * DELTA_THRESHOLD. If the WebSocket is open the command goes via WS,
   * otherwise it falls back to HTTP POST.
   *
   * @param {number} brightness - Integer in [0, 255]
   */
  send(brightness) {
    if (this._destroyed) return;
    this._queuedValue = Math.max(0, Math.min(255, Math.round(brightness)));
    this._scheduleFlush();
  }

  /**
   * Current transport mode.
   * @returns {'websocket' | 'http' | 'disconnected'}
   */
  get mode() {
    return this._mode;
  }

  /**
   * Last measured WebSocket round-trip latency, or null if not available.
   * @returns {number | null}
   */
  get wsLatencyMs() {
    return this._wsLatencyMs;
  }

  /**
   * Release all resources.
   * The instance must not be used after calling destroy().
   */
  destroy() {
    this._destroyed = true;
    this._clearReconnectTimer();
    this._clearPingTimer();
    this._clearFlushTimer();
    this._teardownWS(/* silent */ true);
  }

  // ─── WebSocket lifecycle ──────────────────────────────────────────────────

  /** Create and wire a new WebSocket connection attempt. */
  _openWebSocket() {
    if (this._destroyed || this._ws !== null) return;

    const url = `ws://${this._ip}/ws`;
    this._emitStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[DeviceComm] Cannot construct WebSocket:', err);
      this._onWSFailure();
      return;
    }

    this._ws = ws;

    ws.onopen = () => {
      if (this._ws !== ws) return; // stale reference
      console.info('[DeviceComm] WebSocket connected:', url);
      this._mode = 'websocket';
      this._failCount = 0;
      this._backoffMs = WS_BACKOFF_INITIAL_MS;
      this._reconnecting = false;
      this._emitStatus('connected-ws');
      this._startPingTimer();
    };

    ws.onclose = (ev) => {
      if (this._ws !== ws) return;
      console.warn(`[DeviceComm] WebSocket closed (code=${ev.code} reason="${ev.reason}")`);
      this._ws = null;
      this._clearPingTimer();
      this._wsLatencyMs = null;
      if (!this._destroyed) this._onWSFailure();
    };

    ws.onerror = () => {
      // onclose always fires after onerror — handle failure there.
      console.error('[DeviceComm] WebSocket error.');
    };

    ws.onmessage = (ev) => {
      // Firmware may send a pong or any acknowledgement.
      // We treat any incoming message as a latency probe response.
      if (this._pingSentAt !== null) {
        this._wsLatencyMs = performance.now() - this._pingSentAt;
        this._pingSentAt = null;
        if (this.onLatencyUpdate) this.onLatencyUpdate(this._wsLatencyMs);
      }
    };
  }

  /**
   * Handle a WebSocket failure:
   *  - Increment failure counter.
   *  - After WS_FAILURE_THRESHOLD failures promote HTTP as active transport.
   *  - Schedule the next WS reconnect attempt with back-off.
   */
  _onWSFailure() {
    this._failCount++;

    if (this._failCount >= WS_FAILURE_THRESHOLD) {
      // HTTP becomes the active transport; WS retries continue silently.
      if (this._mode !== 'http') {
        this._mode = 'http';
        this._emitStatus('http-fallback');
        console.warn(`[DeviceComm] Promoted HTTP fallback after ${this._failCount} WS failures.`);
      }
    } else {
      this._mode = 'disconnected';
      this._emitStatus('reconnecting');
    }

    this._scheduleReconnect();
  }

  /** Schedule the next WS reconnect with exponential back-off. */
  _scheduleReconnect() {
    if (this._destroyed || this._reconnecting) return;
    this._reconnecting = true;

    console.info(`[DeviceComm] Reconnecting in ${this._backoffMs} ms…`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnecting = false;
      this._reconnectTimer = null;
      if (!this._destroyed) this._openWebSocket();
    }, this._backoffMs);

    this._backoffMs = Math.min(this._backoffMs * WS_BACKOFF_MULTIPLIER, WS_BACKOFF_MAX_MS);
  }

  /** Close and nullify the current WebSocket without triggering reconnect. */
  _teardownWS(silent = false) {
    this._clearReconnectTimer();
    this._clearPingTimer();
    this._reconnecting = false;

    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      // Silence further events from this socket
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try { ws.close(); } catch (_) { /* ignore */ }
    }

    this._wsLatencyMs = null;
  }

  // ─── Keep-alive ping ─────────────────────────────────────────────────────

  _startPingTimer() {
    this._clearPingTimer();
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._pingSentAt = performance.now();
        try { this._ws.send('ping'); } catch (_) { /* ignore */ }
      }
    }, WS_PING_INTERVAL_MS);
  }

  _clearPingTimer() {
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  // ─── Throttled send ───────────────────────────────────────────────────────

  /** Schedule the next flush, respecting the 20 Hz rate limit. */
  _scheduleFlush() {
    if (this._flushTimer !== null) return; // already pending

    const elapsed = performance.now() - this._lastSentTime;
    const delay   = Math.max(0, SEND_INTERVAL_MS - elapsed);

    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, delay);
  }

  /** Dispatch the queued brightness value if it passes the delta filter. */
  _flush() {
    if (this._queuedValue === null) return;

    const value = this._queuedValue;
    this._queuedValue = null;

    // Delta threshold: skip if change is imperceptible
    if (Math.abs(value - this._lastSentValue) < DELTA_THRESHOLD) return;

    this._lastSentValue = value;
    this._lastSentTime  = performance.now();

    const payload = JSON.stringify({ cmd: 'strip', val: value });

    if (this._mode === 'websocket' && this._ws?.readyState === WebSocket.OPEN) {
      this._dispatchWS(payload);
    } else {
      // HTTP path: also used when mode is 'http' (fallback active)
      this._dispatchHTTP(payload);
    }
  }

  /**
   * Send a pre-serialised JSON payload via WebSocket.
   * Falls back to HTTP if the send throws (e.g., buffer full).
   * @param {string} payload
   */
  _dispatchWS(payload) {
    try {
      this._ws.send(payload);
    } catch (err) {
      console.error('[DeviceComm] WS send error, falling back to HTTP:', err);
      this._dispatchHTTP(payload);
    }
  }

  /**
   * Send a pre-serialised JSON payload via HTTP POST.
   * Attempts to restore the WebSocket on success.
   * @param {string} payload
   */
  async _dispatchHTTP(payload) {
    const url = `http://${this._ip}/api/cmd`;
    try {
      const resp = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    payload,
        signal:  AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      if (!resp.ok) {
        console.warn(`[DeviceComm] HTTP ${resp.status} from device.`);
        this._emitStatus('http-error');
        return;
      }

      // HTTP is working — attempt to restore WS if not already trying
      if (this._ws === null && !this._reconnecting) {
        console.info('[DeviceComm] HTTP success — attempting WS restore…');
        this._failCount = 0;
        this._backoffMs = WS_BACKOFF_INITIAL_MS;
        this._scheduleReconnect();
      }
    } catch (err) {
      console.error('[DeviceComm] HTTP POST failed:', err);
      this._emitStatus('http-error');
    }
  }

  // ─── Timers ───────────────────────────────────────────────────────────────

  _clearReconnectTimer() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _clearFlushTimer() {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** @param {string} status */
  _emitStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }
}
