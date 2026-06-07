/**
 * App.js — GestureLight Main Orchestrator
 *
 * Boots the application and wires all subsystems together.
 *
 * Data flow (per frame, up to 60 fps)
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  VisionEngine
 *    │  onTrackingData({ bothHandsVisible, normalizedDistance, … })
 *    ▼
 *  GestureDetector.process(data)
 *    │  → { brightness: 0–255, state: ACTIVE | OFF | TRACKING_LOST }
 *    ▼
 *  EMAFilter.update(brightness)          ← medium smoothing (α = 0.12)
 *    │  → smoothedBrightness
 *    ▼
 *  DeviceComm.send(smoothedBrightness)   ← throttled 20 Hz + delta filter
 *    │
 *    ├─ WebSocket  ws://{ip}/ws          ← primary
 *    └─ HTTP POST  http://{ip}/api/cmd   ← fallback
 *
 *  UIController.setBrightness(…)
 *  UIController.drawLandmarks(…)
 *  UIController.updateDebug(…)           ← only when ?debug=true
 *
 * Reconnect flow
 * ──────────────
 *  onStatusChange('connected-ws') → restore last brightness from Settings.
 *
 * Error handling
 * ──────────────
 *  VisionEngine errors (permission denied, model load fail) are caught and
 *  displayed to the user. The app always transitions out of the loading screen
 *  to avoid being stuck.
 */

import { Settings }        from '../settings/Settings.js';
import { EMAFilter }       from '../smoothing/EMAFilter.js';
import { DeviceComm }      from '../communication/DeviceComm.js';
import { VisionEngine }    from '../vision/VisionEngine.js';
import { GestureDetector } from '../gestures/GestureDetector.js';
import { UIController }    from '../ui/UIController.js';
import { Diagnostics }     from '../diagnostics/Diagnostics.js';

/**
 * EMA alpha for brightness smoothing.
 * 0.12 provides medium smoothing — responsive but with no visible jitter.
 */
const BRIGHTNESS_ALPHA = 0.12;

/**
 * Loading progress messages keyed by progress threshold.
 * The last matching threshold wins.
 */
const LOAD_MESSAGES = [
  [0.00, 'Starting up…'],
  [0.05, 'Loading MediaPipe library from CDN…'],
  [0.18, 'Resolving WebAssembly runtime…'],
  [0.35, 'Loading hand detection model…'],
  [0.62, 'Loading pose estimation model…'],
  [0.82, 'Requesting camera access…'],
  [0.95, 'Almost ready…'],
  [1.00, 'Ready!'],
];

class App {
  constructor() {
    this._diag     = new Diagnostics();
    this._ui       = new UIController();
    this._vision   = new VisionEngine();
    this._gestures = new GestureDetector();
    this._smoother = new EMAFilter(BRIGHTNESS_ALPHA, 0);
    this._comm     = new DeviceComm(Settings.getDeviceIP());

    /** Last integer brightness sent — used for Settings.setLastBrightness. */
    this._prevBrightness = -1;

    /** Latest WS latency measurement forwarded from DeviceComm. */
    this._wsLatencyMs = null;
  }

  // ─── Boot sequence ────────────────────────────────────────────────────────

  async run() {
    // ── 1. Debug panel ───────────────────────────────────────────────────
    this._ui.setDebugVisible(this._diag.isDebugEnabled);

    // ── 2. Device card ───────────────────────────────────────────────────
    this._ui.setDeviceIP(Settings.getDeviceIP());
    this._ui.bindDeviceCard(ip => this._onDeviceIPSave(ip));

    // ── 3. Camera selector ───────────────────────────────────────────────
    this._ui.bindCameraSelect(id => this._onCameraChange(id));

    // ── 4. Wire VisionEngine callbacks ───────────────────────────────────
    this._vision.onProgress = (p) => {
      const msg = LOAD_MESSAGES
        .filter(([threshold]) => p >= threshold)
        .at(-1)?.[1] ?? 'Loading…';
      this._ui.setLoadingProgress(p, msg);
    };

    this._vision.onCamerasChanged = (devices) => {
      this._ui.populateCameraList(devices, this._vision.activeDeviceId);
    };

    this._vision.onTrackingData = (data) => {
      this._onFrame(data);
    };

    this._vision.onError = (err) => {
      // Show a human-readable error in the loading status.
      const msg = err?.name === 'NotAllowedError'
        ? 'Camera permission denied — allow access and refresh the page.'
        : `Initialisation failed: ${err?.message ?? String(err)}`;
      this._ui.setLoadingProgress(1, msg);
      console.error('[App] Vision initialisation error:', err);
    };

    // ── 5. Wire GestureDetector callbacks ────────────────────────────────
    this._gestures.onStateChange = (newState) => {
      this._ui.setTrackingStatus(newState, /* assume visible when state changes */ true);
      this._ui.setGestureStatus(newState);

      // When the OFF gesture fires, snap the smoother to zero immediately so
      // the gauge drops instantly rather than blending down.
      if (newState === 'OFF') {
        this._smoother.reset(0);
        Settings.setLastBrightness(0);
      }
    };

    // ── 6. Wire DeviceComm callbacks ─────────────────────────────────────
    this._comm.onStatusChange = (status) => {
      this._ui.setConnectionStatus(status);

      // After a successful connection (WS or HTTP) restore the last-known
      // brightness so the LED strip immediately returns to its prior level.
      if (status === 'connected-ws' || status === 'http-fallback') {
        const saved = Settings.getLastBrightness();
        if (saved > 0) {
          this._comm.send(saved);
          this._diag.log('Restored brightness after connect:', saved);
        }
      }
    };

    this._comm.onLatencyUpdate = (ms) => {
      this._wsLatencyMs = ms;
    };

    // ── 7. Start network connection ──────────────────────────────────────
    this._comm.connect();
    this._ui.setConnectionStatus('connecting');

    // ── 8. Initialise vision (loads models + starts camera) ──────────────
    const videoEl       = document.getElementById('camera-video');
    const preferredCam  = Settings.getCameraDeviceId();

    try {
      await this._vision.initialize(videoEl, preferredCam);
    } catch (_) {
      // Error already reported via onError callback.
    } finally {
      // Always exit the loading screen regardless of success or failure.
      this._ui.showApp();
    }
  }

  // ─── Per-frame handler ────────────────────────────────────────────────────

  /**
   * Called by VisionEngine for every processed video frame (up to ~60/s).
   *
   * @param {{
   *   bothHandsVisible  : boolean,
   *   hand1             : { x: number, y: number } | null,
   *   hand2             : { x: number, y: number } | null,
   *   handDistance      : number,
   *   shoulderWidth     : number,
   *   normalizedDistance: number,
   *   handConfidence    : number,
   *   poseDetected      : boolean,
   *   fps               : number,
   *   frameCount        : number,
   *   landmarks         : object,
   * }} data
   */
  _onFrame(data) {
    // ── Gesture detection ────────────────────────────────────────────────
    const { brightness: rawBrightness, state } = this._gestures.process(data);

    // ── Smoothing ────────────────────────────────────────────────────────
    const smoothed    = this._smoother.update(rawBrightness);
    const brightness  = Math.round(smoothed);

    // ── Send to device (throttled + delta-filtered inside DeviceComm) ────
    this._comm.send(brightness);

    // ── Persist latest brightness (for reconnect restore) ────────────────
    if (brightness !== this._prevBrightness) {
      this._prevBrightness = brightness;
      // Only persist non-zero values so a full fade-out doesn't clear memory.
      if (brightness > 0) Settings.setLastBrightness(brightness);
    }

    // ── Update UI ────────────────────────────────────────────────────────
    this._ui.setBrightness(brightness, state, data.normalizedDistance);
    this._ui.setTrackingStatus(state, data.bothHandsVisible);
    this._ui.setGestureStatus(state);
    this._ui.drawLandmarks(data.landmarks, data.bothHandsVisible, data.hand1, data.hand2);

    // ── Debug panel ──────────────────────────────────────────────────────
    if (this._diag.isDebugEnabled) {
      this._ui.updateDebug({
        fps:               data.fps,
        handConfidence:    data.handConfidence,
        shoulderWidth:     data.shoulderWidth,
        rawHandDistance:   data.handDistance,
        normalizedDistance: data.normalizedDistance,
        brightness,
        wsLatencyMs:       this._wsLatencyMs,
        connectionMode:    this._comm.mode,
        gestureState:      state,
        frameCount:        data.frameCount,
      });
    }
  }

  // ─── User interaction handlers ────────────────────────────────────────────

  /**
   * Save a new device IP from the settings card.
   * Validates the address then reconnects DeviceComm.
   * @param {string} ip
   */
  _onDeviceIPSave(ip) {
    if (!Settings.setDeviceIP(ip)) {
      this._ui.showDeviceFeedback('error', 'Invalid address. Enter a valid IPv4 or hostname.');
      return;
    }
    this._ui.showDeviceFeedback('success', `Saved — connecting to ${ip}…`);
    this._comm.setIP(ip);
    this._diag.log('Device IP updated:', ip);
  }

  /**
   * Switch to a different camera from the selector dropdown.
   * @param {string} deviceId
   */
  async _onCameraChange(deviceId) {
    Settings.setCameraDeviceId(deviceId);
    this._diag.log('Switching camera:', deviceId);
    try {
      await this._vision.switchCamera(deviceId);
    } catch (err) {
      console.error('[App] Camera switch failed:', err);
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const app = new App();
app.run().catch(err => console.error('[App] Unhandled boot error:', err));
