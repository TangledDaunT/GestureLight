/**
 * VisionEngine.js
 *
 * Camera access and real-time hand + pose tracking via MediaPipe Tasks Vision.
 *
 * Models used
 * ───────────
 *  HandLandmarker  – detects up to 2 hands, 21 landmarks each.
 *                    Landmark 0 = WRIST (used as the hand anchor point).
 *  PoseLandmarker  – detects body pose, 33 landmarks.
 *                    Landmarks 11 (left shoulder) and 12 (right shoulder)
 *                    are used to compute shoulder width for distance normalisation.
 *
 * Distance normalisation
 * ──────────────────────
 *  Raw hand distance is measured in normalised image coordinates [0, 1].
 *  This varies with camera distance, so it is divided by the shoulder width
 *  (also in normalised coords) to produce a scale-independent ratio.
 *
 *  normalised_distance = hand_distance / shoulder_width
 *
 *  Shoulder width is kept as a running average of the last 30 readings to
 *  prevent jitter from momentarily bad pose readings. If pose is not detected
 *  the cached average (or a sensible default) is used.
 *
 * GPU delegate
 * ────────────
 *  Both models attempt GPU acceleration. If GPU creation fails (certain
 *  Linux drivers, WebGL restrictions) they fall back to CPU automatically.
 *
 * Emitted data (onTrackingData callback)
 * ──────────────────────────────────────
 *  {
 *    bothHandsVisible : boolean,
 *    hand1            : { x, y } | null,   // normalised wrist of hand 0
 *    hand2            : { x, y } | null,   // normalised wrist of hand 1
 *    handDistance     : number,             // raw normalised distance
 *    shoulderWidth    : number,             // normalised shoulder width
 *    normalizedDistance: number,            // handDistance / shoulderWidth, clamped [0,1]
 *    handConfidence   : number,             // average handedness score [0,1]
 *    poseDetected     : boolean,
 *    fps              : number,
 *    frameCount       : number,
 *    landmarks        : { hands, handedness, pose }
 *  }
 */

// ── MediaPipe CDN ─────────────────────────────────────────────────────────────
// Pin to a stable release. Update the version string here to upgrade.
const MP_VERSION = '0.10.14';
const MP_CDN     = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const WASM_PATH  = `${MP_CDN}/wasm`;

const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// ── Constants ────────────────────────────────────────────────────────────────

/** MediaPipe pose landmark indices for shoulders. */
const POSE = { LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12 };

/** MediaPipe hand landmark index for the wrist. */
const WRIST = 0;

/**
 * Fallback shoulder width (normalised units) when pose has never been detected.
 * Corresponds roughly to a person sitting ~0.6 m from the camera.
 */
const DEFAULT_SHOULDER_WIDTH = 0.38;

/** Number of shoulder-width samples kept in the rolling average. */
const SHOULDER_HISTORY = 30;

/** Minimum landmark visibility score to accept a shoulder reading. */
const MIN_VISIBILITY = 0.45;

/** Frames used in the rolling FPS window. */
const FPS_WINDOW = 30;

export class VisionEngine {
  constructor() {
    /** @type {HTMLVideoElement | null} */
    this._video = null;

    /** @type {MediaStream | null} */
    this._stream = null;

    /** @type {any} HandLandmarker MediaPipe instance */
    this._hands = null;

    /** @type {any} PoseLandmarker MediaPipe instance */
    this._pose = null;

    /** requestAnimationFrame ID of the active processing loop. */
    this._rafId = null;

    /** Whether the processing loop is running. */
    this._running = false;

    /** Whether the browser tab is currently hidden (pauses loop). */
    this._tabHidden = false;

    /** Rolling buffer of shoulder width samples for running average. */
    this._shoulderHistory = /** @type {number[]} */ ([]);

    /** Last valid shoulder width (used when pose is not detected). */
    this._cachedShoulderWidth = DEFAULT_SHOULDER_WIDTH;

    /** Timestamps of the last FPS_WINDOW frames for FPS calculation. */
    this._fpsTimestamps = /** @type {number[]} */ ([]);

    /** Monotonically increasing frame counter. */
    this._frameCount = 0;

    /** Current calculated FPS. */
    this._fps = 0;

    /** Currently active camera device ID. */
    this._activeDeviceId = null;

    /** List of available video input devices. */
    this._devices = /** @type {MediaDeviceInfo[]} */ ([]);

    // ── Callbacks ──────────────────────────────────────────────────────────
    /** @type {((data: object) => void) | null} */
    this.onTrackingData = null;

    /** @type {((devices: MediaDeviceInfo[]) => void) | null} */
    this.onCamerasChanged = null;

    /** @type {((progress: number) => void) | null} */
    this.onProgress = null;

    /** @type {((error: Error) => void) | null} */
    this.onError = null;

    // Pause/resume on tab visibility change to save resources.
    this._onVisibilityChange = () => { this._tabHidden = document.hidden; };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  // ─── Initialisation ───────────────────────────────────────────────────────

  /**
   * Load MediaPipe models and start the camera.
   * Emits onProgress(0–1) as work advances.
   *
   * @param {HTMLVideoElement} videoElement
   * @param {string | null}    preferredDeviceId  Saved camera from settings.
   */
  async initialize(videoElement, preferredDeviceId = null) {
    this._video = videoElement;

    try {
      // 1. Import the MediaPipe Tasks Vision bundle (ESM, loaded from CDN).
      this._emitProgress(0.05);
      const { FilesetResolver, HandLandmarker, PoseLandmarker } = await import(
        `${MP_CDN}/vision_bundle.mjs`
      );

      // 2. Resolve WebAssembly runtime files.
      this._emitProgress(0.18);
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);

      // 3. Create HandLandmarker (GPU → CPU fallback).
      this._emitProgress(0.35);
      this._hands = await this._createHandLandmarker(vision, HandLandmarker);

      // 4. Create PoseLandmarker (GPU → CPU fallback).
      this._emitProgress(0.62);
      this._pose = await this._createPoseLandmarker(vision, PoseLandmarker);

      // 5. Request camera access and enumerate devices.
      this._emitProgress(0.82);
      await this._startCamera(preferredDeviceId);

      this._emitProgress(1.0);
    } catch (err) {
      console.error('[VisionEngine] Initialisation failed:', err);
      if (this.onError) this.onError(err);
      throw err;
    }
  }

  /**
   * Attempt to create HandLandmarker with GPU delegate.
   * Falls back to CPU if GPU creation throws.
   */
  async _createHandLandmarker(vision, HandLandmarker) {
    const baseConfig = {
      runningMode:                 'VIDEO',
      numHands:                    2,
      minHandDetectionConfidence:  0.5,
      minHandPresenceConfidence:   0.5,
      minTrackingConfidence:       0.5,
    };

    try {
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        ...baseConfig,
      });
    } catch {
      console.warn('[VisionEngine] HandLandmarker GPU failed, using CPU.');
      return HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'CPU' },
        ...baseConfig,
      });
    }
  }

  /**
   * Attempt to create PoseLandmarker with GPU delegate.
   * Falls back to CPU if GPU creation throws.
   */
  async _createPoseLandmarker(vision, PoseLandmarker) {
    const baseConfig = {
      runningMode:                  'VIDEO',
      numPoses:                     1,
      minPoseDetectionConfidence:   0.5,
      minPosePresenceConfidence:    0.5,
      minTrackingConfidence:        0.5,
    };

    try {
      return await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
        ...baseConfig,
      });
    } catch {
      console.warn('[VisionEngine] PoseLandmarker GPU failed, using CPU.');
      return PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
        ...baseConfig,
      });
    }
  }

  // ─── Camera management ───────────────────────────────────────────────────

  /**
   * Start the camera stream with an optional device preference.
   * On failure with a specific deviceId it retries with the default camera.
   *
   * @param {string | null} deviceId
   */
  async _startCamera(deviceId = null) {
    this._stopStream();

    const constraints = {
      video: {
        width:     { ideal: 640 },
        height:    { ideal: 480 },
        frameRate: { ideal: 60, min: 24 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };

    try {
      this._stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (firstErr) {
      if (deviceId) {
        // Retry without the device constraint (camera may have been unplugged).
        console.warn('[VisionEngine] Preferred camera unavailable, trying default.');
        try {
          this._stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
          });
        } catch (secondErr) {
          throw secondErr;
        }
      } else {
        throw firstErr;
      }
    }

    this._video.srcObject = this._stream;
    this._activeDeviceId  = this._stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;

    // Wait for metadata so we know the video dimensions.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video metadata timeout')), 12_000);
      this._video.onloadedmetadata = () => { clearTimeout(timeout); resolve(); };
      this._video.onerror          = (e) => { clearTimeout(timeout); reject(e); };
    });

    await this._video.play();

    // Enumerate cameras now that permission has been granted (labels are
    // only available after getUserMedia resolves).
    await this._enumerateCameras();

    // Start the frame-processing loop.
    this._startLoop();
  }

  /**
   * Switch to a different camera at runtime.
   * @param {string} deviceId
   */
  async switchCamera(deviceId) {
    this._stopLoop();
    await this._startCamera(deviceId);
  }

  /** Enumerate available video-input devices and emit onCamerasChanged. */
  async _enumerateCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this._devices = all.filter(d => d.kind === 'videoinput');
      if (this.onCamerasChanged) this.onCamerasChanged(this._devices);

      // Re-enumerate if devices are plugged/unplugged.
      navigator.mediaDevices.ondevicechange = () => this._enumerateCameras();
    } catch (err) {
      console.warn('[VisionEngine] Camera enumeration failed:', err);
    }
  }

  // ─── Processing loop ─────────────────────────────────────────────────────

  _startLoop() {
    this._running    = true;
    this._frameCount = 0;
    this._fpsTimestamps.length = 0;
    this._loop();
  }

  _stopLoop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _loop() {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(() => this._loop());

    // Skip frames while the tab is hidden.
    if (this._tabHidden) return;

    // Skip if the video is not yet producing frames.
    if (!this._video || this._video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return;

    const ts = performance.now();
    this._frameCount++;
    this._updateFPS(ts);

    // Run both models on the same frame timestamp.
    const handResult = this._hands.detectForVideo(this._video, ts);
    const poseResult = this._pose.detectForVideo(this._video, ts);

    const data = this._buildTrackingData(handResult, poseResult);

    if (this.onTrackingData) this.onTrackingData(data);
  }

  // ─── Result processing ───────────────────────────────────────────────────

  /**
   * Determine if a hand is making a thumbs-up gesture.
   */
  _isThumbsUp(landmarks) {
    if (!landmarks || landmarks.length < 21) return false;

    const thumbTip = landmarks[4], thumbIp = landmarks[3], thumbMcp = landmarks[2];
    const indexTip = landmarks[8], indexPip = landmarks[6];
    const middleTip = landmarks[12], middlePip = landmarks[10];
    const ringTip = landmarks[16], ringPip = landmarks[14];
    const pinkyTip = landmarks[20], pinkyPip = landmarks[18];

    const isThumbExtended = thumbTip.y < thumbIp.y && thumbIp.y < thumbMcp.y;
    const isIndexFolded = indexTip.y > indexPip.y;
    const isMiddleFolded = middleTip.y > middlePip.y;
    const isRingFolded = ringTip.y > ringPip.y;
    const isPinkyFolded = pinkyTip.y > pinkyPip.y;

    return isThumbExtended && isIndexFolded && isMiddleFolded && isRingFolded && isPinkyFolded;
  }

  /**
   * Convert raw MediaPipe results into a normalised tracking data object.
   *
   * @param {any} handResult
   * @param {any} poseResult
   * @returns {object}
   */
  _buildTrackingData(handResult, poseResult) {
    const bothHandsVisible = handResult.landmarks.length >= 2;

    // ── Hand wrist positions & thumbs up detection ───────────────────────
    let hand1 = null;
    let hand2 = null;
    let bothThumbsUp = false;

    if (handResult.landmarks.length >= 1) {
      const w = handResult.landmarks[0][WRIST];
      hand1 = { x: w.x, y: w.y };
    }
    if (handResult.landmarks.length >= 2) {
      const w = handResult.landmarks[1][WRIST];
      hand2 = { x: w.x, y: w.y };
      bothThumbsUp = this._isThumbsUp(handResult.landmarks[0]) && this._isThumbsUp(handResult.landmarks[1]);
    }

    // ── Average hand confidence ──────────────────────────────────────────
    let handConfidence = 0;
    if (handResult.handedness.length > 0) {
      const scores = handResult.handedness.map(h => h[0]?.score ?? 0);
      handConfidence = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    // ── Raw hand-to-hand distance (normalised image coords) ──────────────
    let handDistance = 0;
    if (hand1 && hand2) {
      const dx = hand2.x - hand1.x;
      const dy = hand2.y - hand1.y;
      handDistance = Math.sqrt(dx * dx + dy * dy);
    }

    // ── Shoulder width from pose ─────────────────────────────────────────
    let poseDetected = false;

    if (poseResult.landmarks.length > 0) {
      const lms = poseResult.landmarks[0];
      const ls  = lms[POSE.LEFT_SHOULDER];
      const rs  = lms[POSE.RIGHT_SHOULDER];

      if (
        (ls?.visibility ?? 0) >= MIN_VISIBILITY &&
        (rs?.visibility ?? 0) >= MIN_VISIBILITY
      ) {
        const dx = rs.x - ls.x;
        const dy = rs.y - ls.y;
        const w  = Math.sqrt(dx * dx + dy * dy);

        if (w > 0.02) {
          this._shoulderHistory.push(w);
          if (this._shoulderHistory.length > SHOULDER_HISTORY) {
            this._shoulderHistory.shift();
          }
          this._cachedShoulderWidth =
            this._shoulderHistory.reduce((a, b) => a + b, 0) /
            this._shoulderHistory.length;
          poseDetected = true;
        }
      }
    }

    const shoulderWidth = this._cachedShoulderWidth;

    // ── Normalised hand distance ─────────────────────────────────────────
    let normalizedDistance = 0;
    if (bothHandsVisible && shoulderWidth > 0) {
      normalizedDistance = Math.max(0, Math.min(1, handDistance / shoulderWidth));
    }

    return {
      bothHandsVisible,
      bothThumbsUp,
      hand1,
      hand2,
      handDistance,
      shoulderWidth,
      normalizedDistance,
      handConfidence,
      poseDetected,
      fps:        this._fps,
      frameCount: this._frameCount,
      landmarks: {
        hands:      handResult.landmarks,
        handedness: handResult.handedness,
        pose:       poseResult.landmarks[0] ?? null,
      },
    };
  }

  // ─── FPS ────────────────────────────────────────────────────────────────

  _updateFPS(ts) {
    this._fpsTimestamps.push(ts);
    if (this._fpsTimestamps.length > FPS_WINDOW) this._fpsTimestamps.shift();

    if (this._fpsTimestamps.length >= 2) {
      const span = this._fpsTimestamps.at(-1) - this._fpsTimestamps[0];
      this._fps  = Math.round((this._fpsTimestamps.length - 1) / (span / 1000));
    }
  }

  // ─── Stream management ───────────────────────────────────────────────────

  _stopStream() {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    if (this._video) this._video.srcObject = null;
  }

  // ─── Public getters ──────────────────────────────────────────────────────

  /** @returns {MediaDeviceInfo[]} */
  get cameras() { return this._devices; }

  /** @returns {string | null} */
  get activeDeviceId() { return this._activeDeviceId; }

  // ─── Resource cleanup ────────────────────────────────────────────────────

  /**
   * Destroy the engine and release all resources.
   * Must be called when the application shuts down.
   */
  destroy() {
    this._stopLoop();
    this._stopStream();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    navigator.mediaDevices.ondevicechange = null;

    try { this._hands?.close(); } catch (_) { /* ignore */ }
    try { this._pose?.close();  } catch (_) { /* ignore */ }
    this._hands = null;
    this._pose  = null;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** @param {number} p - 0.0 to 1.0 */
  _emitProgress(p) {
    if (this.onProgress) this.onProgress(p);
  }
}
