/**
 * UIController.js
 *
 * Owns all DOM mutations. No other module touches the DOM directly.
 *
 * Responsibilities
 * ────────────────
 *  • Loading screen progress and transition.
 *  • Brightness gauge (SVG arc) and numeric display.
 *  • Connection and tracking status labels.
 *  • Camera preview canvas overlay (hand + pose landmarks).
 *  • Device IP editor (input + save button + feedback).
 *  • Camera selector dropdown.
 *  • Debug panel.
 *
 * Canvas drawing notes
 * ────────────────────
 *  The <video> element is CSS-mirrored (transform: scaleX(-1)) for a natural
 *  selfie view. The <canvas> is drawn in the original coordinate space, then
 *  a canvas-context mirror transform is applied so landmarks align with the
 *  mirrored video.
 *
 *  Mirror transform:
 *    ctx.translate(canvas.width, 0);
 *    ctx.scale(-1, 1);
 *    // then draw using raw landmark.x values
 */

import { GestureState } from '../gestures/GestureDetector.js';

// ── Hand landmark connectivity (MediaPipe index pairs) ────────────────────────
const HAND_CONNECTIONS = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm cross-braces
  [5, 9], [9, 13], [13, 17],
];

// ── SVG gauge geometry ────────────────────────────────────────────────────────
// Circle r=80, circumference ≈ 502. The arc covers 270° of the circle (¾).
// 270° / 360° × 502 ≈ 376.5. We use 377 for a clean value.
const GAUGE_FULL_CIRC = 502;   // Full circumference for a r=80 circle
const GAUGE_ARC_MAX   = 377;   // 270° of arc (¾ of full circle)

export class UIController {
  constructor() {
    // ── Element references (acquired once at startup) ────────────────────────
    this._el = {
      // Loading
      loadingScreen:   this._q('loading-screen'),
      loadingProgress: this._q('loading-progress'),
      loadingStatus:   this._q('loading-status'),

      // App shell
      app:             this._q('app'),

      // Header
      statusDotGlobal: this._q('global-status-dot'),

      // Camera
      video:                this._q('camera-video'),
      canvas:               this._q('camera-canvas'),
      cameraMessage:        this._q('camera-message'),
      trackingLostOverlay:  this._q('tracking-lost-overlay'),
      lightsOffOverlay:     this._q('lights-off-overlay'),
      trackingBadge:        this._q('tracking-badge'),

      // Status card
      statusConnection: this._q('status-connection'),
      statusTransport:  this._q('status-transport'),
      statusTracking:   this._q('status-tracking'),
      statusGesture:    this._q('status-gesture'),

      // Brightness card
      gaugeFill:       this._q('gauge-fill'),
      brightnessVal:   this._q('brightness-percent'),
      brightnessUnit:  this._q('brightness-unit'),
      brightnessRaw:   this._q('brightness-raw-value'),
      brightnessDist:  this._q('brightness-distance'),

      // Device card
      deviceIP:        this._q('device-ip'),
      deviceSaveBtn:   this._q('device-save-btn'),
      deviceFeedback:  this._q('device-feedback'),

      // Camera select
      cameraSelect: this._q('camera-select'),

      // Debug panel
      debugPanel:      this._q('debug-panel'),
      dbgFPS:          this._q('debug-fps'),
      dbgHandConf:     this._q('debug-hand-confidence'),
      dbgShoulderW:    this._q('debug-shoulder-width'),
      dbgRawDist:      this._q('debug-raw-distance'),
      dbgNormDist:     this._q('debug-norm-distance'),
      dbgBrightness:   this._q('debug-brightness'),
      dbgWsLatency:    this._q('debug-ws-latency'),
      dbgConnMode:     this._q('debug-conn-mode'),
      dbgGestureState: this._q('debug-gesture-state'),
      dbgFrameCount:   this._q('debug-frame-count'),
    };

    /** @type {CanvasRenderingContext2D} */
    this._ctx = this._el.canvas.getContext('2d', { alpha: true });

    // Keep canvas pixel dimensions in sync with the preview container.
    this._syncCanvasSize();
    window.addEventListener('resize', () => this._syncCanvasSize());
    this._el.video.addEventListener('loadedmetadata', () => this._syncCanvasSize());

    // Debounce timer for device-feedback auto-hide.
    this._feedbackTimer = null;
  }

  // ─── Loading screen ───────────────────────────────────────────────────────

  /**
   * Update the loading progress bar and status message.
   * @param {number} progress - 0.0 to 1.0
   * @param {string} message
   */
  setLoadingProgress(progress, message) {
    this._el.loadingProgress.style.width = `${Math.round(progress * 100)}%`;
    if (message) this._el.loadingStatus.textContent = message;
  }

  /** Cross-fade from loading screen to the main application UI. */
  showApp() {
    this._el.loadingScreen.classList.add('fade-out');
    this._el.app.classList.remove('hidden');
    setTimeout(() => this._el.loadingScreen.classList.add('hidden'), 520);
  }

  // ─── Device card ──────────────────────────────────────────────────────────

  /**
   * Populate the device IP input with a saved value.
   * @param {string} ip
   */
  setDeviceIP(ip) {
    this._el.deviceIP.value = ip;
  }

  /**
   * Wire device-card interactions.
   * @param {(ip: string) => void} onSave
   */
  bindDeviceCard(onSave) {
    const trigger = () => onSave(this._el.deviceIP.value.trim());
    this._el.deviceSaveBtn.addEventListener('click', trigger);
    this._el.deviceIP.addEventListener('keydown', e => {
      if (e.key === 'Enter') trigger();
    });
  }

  /**
   * Show a transient feedback message below the device IP input.
   * @param {'success' | 'error'} type
   * @param {string} message
   */
  showDeviceFeedback(type, message) {
    clearTimeout(this._feedbackTimer);
    const el = this._el.deviceFeedback;
    el.textContent = message;
    el.className   = `form-feedback form-feedback--${type}`;
    el.classList.remove('hidden');
    this._feedbackTimer = setTimeout(() => el.classList.add('hidden'), 3_500);
  }

  // ─── Camera card ──────────────────────────────────────────────────────────

  /**
   * Populate the camera dropdown.
   * @param {MediaDeviceInfo[]} devices
   * @param {string | null}     selectedId
   */
  populateCameraList(devices, selectedId) {
    const sel = this._el.cameraSelect;
    sel.innerHTML = '';

    if (devices.length === 0) {
      sel.appendChild(Object.assign(document.createElement('option'), {
        textContent: 'No cameras found',
      }));
      return;
    }

    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value       = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      opt.selected    = d.deviceId === selectedId;
      sel.appendChild(opt);
    });
  }

  /**
   * Wire camera selection changes.
   * @param {(deviceId: string) => void} onChange
   */
  bindCameraSelect(onChange) {
    this._el.cameraSelect.addEventListener('change', e => {
      const id = /** @type {HTMLSelectElement} */ (e.target).value;
      if (id) onChange(id);
    });
  }

  // ─── Connection status ────────────────────────────────────────────────────

  /**
   * Update connection status labels and the header status dot.
   * @param {'connecting'|'connected-ws'|'http-fallback'|'reconnecting'|'http-error'|'disconnected'} status
   */
  setConnectionStatus(status) {
    const { statusConnection, statusTransport, statusDotGlobal } = this._el;

    // Reset classes before applying new ones.
    statusConnection.className = 'status-value';
    statusDotGlobal.className  = 'status-dot';

    switch (status) {
      case 'connected-ws':
        statusConnection.textContent = 'Connected';
        statusConnection.classList.add('status-value--connected');
        statusTransport.textContent  = 'WebSocket';
        statusTransport.className    = 'status-value status-value--active';
        statusDotGlobal.classList.add('status-dot--connected');
        break;

      case 'http-fallback':
        statusConnection.textContent = 'Connected (HTTP)';
        statusConnection.classList.add('status-value--connected');
        statusTransport.textContent  = 'HTTP Fallback';
        statusTransport.className    = 'status-value status-value--http';
        statusDotGlobal.classList.add('status-dot--connecting');
        break;

      case 'connecting':
        statusConnection.textContent = 'Connecting…';
        statusConnection.classList.add('status-value--connecting');
        statusTransport.textContent  = '—';
        statusTransport.className    = 'status-value status-value--neutral';
        statusDotGlobal.classList.add('status-dot--connecting');
        break;

      case 'reconnecting':
        statusConnection.textContent = 'Reconnecting…';
        statusConnection.classList.add('status-value--connecting');
        statusTransport.textContent  = '—';
        statusTransport.className    = 'status-value status-value--neutral';
        statusDotGlobal.classList.add('status-dot--connecting');
        break;

      case 'http-error':
        statusConnection.textContent = 'Error';
        statusConnection.classList.add('status-value--error');
        statusTransport.textContent  = 'HTTP (Failed)';
        statusTransport.className    = 'status-value status-value--error';
        statusDotGlobal.classList.add('status-dot--error');
        break;

      case 'disconnected':
      default:
        statusConnection.textContent = 'Disconnected';
        statusConnection.classList.add('status-value--neutral');
        statusTransport.textContent  = '—';
        statusTransport.className    = 'status-value status-value--neutral';
        statusDotGlobal.classList.add('status-dot--neutral');
    }
  }

  // ─── Tracking / gesture status ────────────────────────────────────────────

  /**
   * Reflect the current gesture state in the tracking status row and badge.
   * @param {string}  gestureState     - GestureState enum value
   * @param {boolean} bothHandsVisible
   */
  setTrackingStatus(gestureState, bothHandsVisible) {
    const { statusTracking, trackingBadge, trackingLostOverlay, lightsOffOverlay } = this._el;

    // Overlays
    const showLost = !bothHandsVisible || gestureState === GestureState.TRACKING_LOST;
    const showOff  = gestureState === GestureState.OFF && bothHandsVisible;

    trackingLostOverlay.classList.toggle('hidden', !showLost);
    lightsOffOverlay.classList.toggle('hidden', !showOff);

    // Status label + badge
    statusTracking.className = 'status-value';
    trackingBadge.className  = 'badge';

    if (gestureState === GestureState.TRACKING_LOST) {
      statusTracking.textContent = 'Tracking Lost';
      statusTracking.classList.add('status-value--lost');
      trackingBadge.textContent  = 'Lost';
      trackingBadge.classList.add('badge--lost');
    } else if (gestureState === GestureState.LOCKED) {
      statusTracking.textContent = 'Locked';
      statusTracking.classList.add('status-value--active');
      trackingBadge.textContent  = 'LOCKED';
      trackingBadge.classList.add('badge--tracking');
    } else if (gestureState === GestureState.OFF) {
      statusTracking.textContent = 'Active';
      statusTracking.classList.add('status-value--active');
      trackingBadge.textContent  = 'OFF';
      trackingBadge.classList.add('badge--off');
    } else {
      statusTracking.textContent = 'Active';
      statusTracking.classList.add('status-value--active');
      trackingBadge.textContent  = 'Tracking';
      trackingBadge.classList.add('badge--tracking');
    }
  }

  /**
   * Update the "Gesture" row in the status card.
   * @param {string} gestureState
   */
  setGestureStatus(gestureState) {
    const { statusGesture } = this._el;
    statusGesture.className = 'status-value';

    switch (gestureState) {
      case GestureState.ACTIVE:
        statusGesture.textContent = 'Brightness Control';
        statusGesture.classList.add('status-value--active');
        break;
      case GestureState.LOCKED:
        statusGesture.textContent = 'Locked';
        statusGesture.classList.add('status-value--active');
        break;
      case GestureState.OFF:
        statusGesture.textContent = 'Lights OFF';
        statusGesture.classList.add('status-value--off');
        break;
      case GestureState.TRACKING_LOST:
        statusGesture.textContent = 'Fading…';
        statusGesture.classList.add('status-value--neutral');
        break;
    }
  }

  // ─── Brightness gauge ────────────────────────────────────────────────────

  /**
   * Update the SVG arc gauge and numeric display.
   *
   * The SVG arc uses stroke-dasharray to fill proportionally:
   *   dasharray = pct × GAUGE_ARC_MAX  (fill portion)
   *   dashoffset = -(GAUGE_FULL_CIRC - dasharray) - offset  (remainder, hidden)
   *
   * @param {number} brightness - Integer [0, 255]
   * @param {string} gestureState
   * @param {number} normalizedDistance - [0, 1] for the "Hand Distance" meta field
   */
  setBrightness(brightness, gestureState, normalizedDistance) {
    const pct = brightness / 255;
    const arc = pct * GAUGE_ARC_MAX;

    // Update gauge arc fill
    this._el.gaugeFill.style.strokeDasharray = `${arc} ${GAUGE_FULL_CIRC}`;
    this._el.gaugeFill.style.stroke          = this._gaugeColor(pct);
    this._el.gaugeFill.style.filter          = pct > 0.01
      ? `drop-shadow(0 0 ${6 + pct * 14}px ${this._gaugeColor(pct)})`
      : 'none';

    // Numeric display
    const displayPct = Math.round(pct * 100);

    if (gestureState === GestureState.OFF) {
      this._el.brightnessVal.textContent  = 'OFF';
      this._el.brightnessUnit.style.opacity = '0';
    } else if (gestureState === GestureState.TRACKING_LOST && brightness === 0) {
      this._el.brightnessVal.textContent  = '—';
      this._el.brightnessUnit.style.opacity = '0';
    } else {
      this._el.brightnessVal.textContent  = displayPct;
      this._el.brightnessUnit.style.opacity = '1';
    }

    // Meta fields
    this._el.brightnessRaw.textContent  = brightness;
    this._el.brightnessDist.textContent =
      normalizedDistance != null
        ? `${Math.round(normalizedDistance * 100)} %`
        : '—';
  }

  /**
   * Return a CSS colour string for the gauge based on brightness level.
   * @param {number} pct - 0.0 to 1.0
   * @returns {string}
   */
  _gaugeColor(pct) {
    if (pct < 0.01)  return 'rgba(255,255,255,0.07)';
    if (pct < 0.30)  return '#f59e0b';  // amber — low
    if (pct < 0.65)  return '#a78bfa';  // purple — mid
    return '#e8e4ff';                   // near-white — high
  }

  // ─── Canvas landmark overlay ──────────────────────────────────────────────

  /**
   * Draw hand skeleton and pose shoulder line on the canvas overlay.
   *
   * @param {{
   *   hands     : any[][],
   *   handedness: any[][],
   *   pose      : any[] | null
   * }} landmarks
   * @param {boolean}               bothHandsVisible
   * @param {{ x:number, y:number } | null} hand1  - Normalised wrist of hand 0
   * @param {{ x:number, y:number } | null} hand2  - Normalised wrist of hand 1
   */
  drawLandmarks(landmarks, bothHandsVisible, hand1, hand2) {
    const { canvas } = this._el;
    const ctx = this._ctx;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    if (!landmarks) return;

    // Apply mirror transform to match the CSS-mirrored <video>.
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);

    // ── Pose shoulder line ───────────────────────────────────────────────
    if (landmarks.pose) {
      const ls = landmarks.pose[11];
      const rs = landmarks.pose[12];

      if (ls && rs) {
        ctx.beginPath();
        ctx.moveTo(ls.x * W, ls.y * H);
        ctx.lineTo(rs.x * W, rs.y * H);
        ctx.strokeStyle = 'rgba(124, 109, 248, 0.35)';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);

        [ls, rs].forEach(p => {
          ctx.beginPath();
          ctx.arc(p.x * W, p.y * H, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(124, 109, 248, 0.55)';
          ctx.fill();
        });
      }
    }

    // ── Hand skeletons ───────────────────────────────────────────────────
    landmarks.hands.forEach((handLms, i) => {
      this._drawHandSkeleton(ctx, handLms, W, H);
    });

    // ── Hand-to-hand distance line ───────────────────────────────────────
    if (bothHandsVisible && hand1 && hand2) {
      ctx.beginPath();
      ctx.moveTo(hand1.x * W, hand1.y * H);
      ctx.lineTo(hand2.x * W, hand2.y * H);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Midpoint dot
      const mx = (hand1.x + hand2.x) / 2 * W;
      const my = (hand1.y + hand2.y) / 2 * H;
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw a single hand's landmark connections and joint dots.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any[]} lms - Array of 21 landmark objects { x, y, z }
   * @param {number} W  - Canvas pixel width
   * @param {number} H  - Canvas pixel height
   */
  _drawHandSkeleton(ctx, lms, W, H) {
    // Connections
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';

    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(lms[a].x * W, lms[a].y * H);
      ctx.lineTo(lms[b].x * W, lms[b].y * H);
      ctx.stroke();
    }

    // Joint dots
    lms.forEach((lm, idx) => {
      const isWrist      = idx === 0;
      const isFingerTip  = [4, 8, 12, 16, 20].includes(idx);

      ctx.beginPath();
      ctx.arc(lm.x * W, lm.y * H, isWrist ? 5.5 : isFingerTip ? 4 : 2.5, 0, Math.PI * 2);

      ctx.fillStyle = isWrist
        ? 'rgba(124, 109, 248, 0.90)'    // accent — wrist
        : isFingerTip
          ? 'rgba(255, 255, 255, 0.85)'  // white  — fingertips
          : 'rgba(255, 255, 255, 0.55)'; // dimmer — knuckles

      ctx.fill();
    });
  }

  // ─── Debug panel ──────────────────────────────────────────────────────────

  /**
   * Show or hide the debug panel.
   * @param {boolean} visible
   */
  setDebugVisible(visible) {
    this._el.debugPanel.classList.toggle('hidden', !visible);
  }

  /**
   * Update all debug display values.
   * @param {{
   *   fps              : number,
   *   handConfidence   : number,
   *   shoulderWidth    : number,
   *   rawHandDistance  : number,
   *   normalizedDistance: number,
   *   brightness       : number,
   *   wsLatencyMs      : number | null,
   *   connectionMode   : string,
   *   gestureState     : string,
   *   frameCount       : number,
   * }} d
   */
  updateDebug(d) {
    const n = (v, dec = 3) =>
      (v === null || v === undefined) ? '—' : Number(v).toFixed(dec);

    this._el.dbgFPS.textContent          = n(d.fps, 0);
    this._el.dbgHandConf.textContent     = d.handConfidence != null
      ? `${Math.round(d.handConfidence * 100)} %` : '—';
    this._el.dbgShoulderW.textContent    = n(d.shoulderWidth);
    this._el.dbgRawDist.textContent      = n(d.rawHandDistance);
    this._el.dbgNormDist.textContent     = n(d.normalizedDistance);
    this._el.dbgBrightness.textContent   = n(d.brightness, 0);
    this._el.dbgWsLatency.textContent    = d.wsLatencyMs != null
      ? `${Math.round(d.wsLatencyMs)} ms` : '—';
    this._el.dbgConnMode.textContent     = d.connectionMode ?? '—';
    this._el.dbgGestureState.textContent = d.gestureState  ?? '—';
    this._el.dbgFrameCount.textContent   = n(d.frameCount, 0);
  }

  // ─── Canvas sizing ────────────────────────────────────────────────────────

  _syncCanvasSize() {
    const container = this._el.video.parentElement;
    if (!container) return;
    const { width, height } = container.getBoundingClientRect();
    this._el.canvas.width  = Math.round(width);
    this._el.canvas.height = Math.round(height);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Shortcut for getElementById with a required-element assertion.
   * @param {string} id
   * @returns {HTMLElement}
   */
  _q(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`[UIController] Missing element #${id}`);
    return el;
  }
}
