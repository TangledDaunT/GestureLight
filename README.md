# GestureLight

GestureLight is a production-quality web application that controls an ESP32-connected LED strip using real-time hand tracking through your webcam.

It uses MediaPipe Tasks Vision to run computer vision entirely in the browser. Gestures map normalized hand distance into smooth LED brightness using a gamma-corrected power curve, all while maintaining a 60 FPS video loop and throttled 20 Hz WebSocket ESP32 commands.

## Installation & Running Locally

Because the browser's `getUserMedia` API (for camera access) requires a secure context, you must run the app either via `https://` or `http://localhost`.

1. Make sure you have Node.js installed.
2. In the project directory, install dependencies (none strictly required, but provides the local web server):
   ```bash
   npm install
   ```
3. Start the local server:
   ```bash
   npm start
   ```
   (This runs `npx serve . --listen 8080 --no-clipboard`)
4. Open your browser to `http://localhost:8080`.
5. Allow camera permissions when prompted.

## Folder Structure

```text
/
├── index.html                  # Main application entry point
├── package.json                # Project configuration and scripts
├── styles/
│   └── main.css                # Apple-style dark mode CSS with glassmorphism
└── src/
    ├── app/
    │   └── App.js              # Main application orchestrator
    ├── communication/
    │   └── DeviceComm.js       # WebSocket & HTTP fallback to ESP32
    ├── diagnostics/
    │   └── Diagnostics.js      # Gated debug logging and panel state
    ├── gestures/
    │   └── GestureDetector.js  # Finite-state machine for gesture logic
    ├── settings/
    │   └── Settings.js         # LocalStorage persistence layer
    ├── smoothing/
    │   └── EMAFilter.js        # Exponential Moving Average for anti-jitter
    ├── ui/
    │   └── UIController.js     # Pure DOM manipulation module
    └── vision/
        └── VisionEngine.js     # MediaPipe Hands + Pose computer vision
```

## Architecture Explanation

GestureLight uses a clean, decoupled architecture:
- **VisionEngine**: Handles camera streams, resolves MediaPipe Wasm files, runs the Hand and Pose Landmark models with GPU delegation (and automatic CPU fallback), calculates normalized distance via shoulder width, and dispatches tracking data up to 60 times a second.
- **GestureDetector**: A finite-state machine that takes raw tracking data, debounces the `OFF` gesture (hands together for 300ms), calculates gamma-corrected brightness (to match human visual perception), and initiates a smooth fade down to zero if tracking is lost.
- **EMAFilter**: An Exponential Moving Average filter that removes jitter from the normalized tracking output, creating fluid brightness changes.
- **DeviceComm**: Manages all network traffic to the ESP32. It attempts a WebSocket connection (`ws://<ip>/ws`). If it fails 3 times, it promotes HTTP POST (`/api/cmd`) to active, while continuing exponential backoff WebSocket retries in the background. It also throttles commands to a maximum of 20 updates per second and implements delta thresholding to avoid sending redundant packets.
- **UIController**: Solely responsible for touching the DOM. Updates SVG arcs, draws HTML5 Canvas overlays mirroring the user's video feed, and changes CSS classes for status updates.
- **App**: The bootstrapper that configures and connects all the modules via callbacks.

## MediaPipe Explanation

The app leverages the modern `@mediapipe/tasks-vision` module via a CDN. We run two models simultaneously on every video frame:
1. **HandLandmarker**: Detects up to 2 hands, using the `WRIST` landmark (index 0) to measure the raw hand distance.
2. **PoseLandmarker**: A lightweight body pose model used purely to extract landmarks 11 (left shoulder) and 12 (right shoulder).

**Why shoulder width?**
Measuring raw pixel distance between hands is heavily skewed by how close the user is to the camera. By capturing shoulder width simultaneously, we normalize the measurement:
`normalized_distance = hand_distance / shoulder_width`
This makes the gesture consistent regardless of camera distance. The system keeps a running average of the last 30 frames of shoulder width to prevent jitter and maintain stability even if the pose model briefly loses the shoulders.

## ESP32 Communication Explanation

The ESP32 is expected to reside at `192.168.1.23` (editable in the UI).
- **Primary (WebSocket)**: Sends JSON like `{"cmd":"strip","val":180}` to `ws://192.168.1.23/ws`. WebSockets are preferred for low-latency continuous control.
- **Fallback (HTTP)**: If the WebSocket disconnects, the app falls back to sending the same JSON payload via `POST http://192.168.1.23/api/cmd`.
- **Throttling**: The ESP32 cannot handle 60 commands per second. `DeviceComm` throttles output to 20Hz (every 50ms) and uses a delta threshold—only sending if the brightness changed by at least 2 units.

## Error Handling

- **Camera Permissions**: Caught cleanly. `UIController` displays an inline "Permission denied" error instead of freezing on the loading screen.
- **MediaPipe Load Failure**: Caught and displayed if the user's browser blocks Wasm or is entirely offline.
- **GPU Failure**: MediaPipe is instructed to use `delegate: "GPU"`. If the browser/OS blocks WebGL compute shaders, the engine safely catches the error and instantiates the `delegate: "CPU"` pipeline instead.
- **Network Drops**: Managed by `DeviceComm`. If the WebSocket drops, it attempts exponential back-off reconnection while switching to HTTP. Once the WebSocket restores, the app re-syncs the current brightness automatically.
- **Tracking Lost**: If hands leave the frame, the `GestureDetector` begins fading the lights to 0 safely, rather than leaving the lights stuck at max brightness or shutting off abruptly.

## Testing Checklist

1. **Camera Selection**: Click the drop-down on the Camera card and switch cameras. Verify the active video feed updates correctly.
2. **Gesture - Increase/Decrease**: Bring hands into frame and spread them apart. Check if the brightness gauge sweeps up. Bring them closer and check if it sweeps down smoothly.
3. **Gesture - Off**: Hold both hands close together (touching) for roughly 0.3 seconds. The status should change to `Lights OFF` and brightness drop to 0.
4. **Gesture - Wake**: After turning lights OFF, separate hands widely. Verify brightness resumes control immediately.
5. **Tracking Loss**: While active, drop both hands out of frame. Verify the status says `Tracking Lost` and the brightness arc fades smoothly to 0.
6. **Network Failure**: Disconnect from the Wi-Fi network that the ESP32 is on. Verify the UI updates to `Connecting...` and eventually `HTTP Fallback` / `Error`. Reconnect to Wi-Fi and ensure it automatically reconnects and restores the last set brightness.
7. **Debug Mode**: Append `?debug=true` to the URL. Verify the debug stats panel appears showing FPS, latency, and confidence values.

## Future Extension Guide

- **Custom Lighting Effects**: Modify `DeviceComm.js` to dispatch different commands. You could detect the `z` axis (depth) of a hand to change the hue, or use the Y-axis to control saturation.
- **Pinch Gestures**: Modify `VisionEngine.js` to expose thumb tip (landmark 4) and index finger tip (landmark 8) distance to enable "pinch-to-toggle" functionality.
- **Service Workers**: Add a `sw.js` and a Web App Manifest to make the application fully PWA compliant and installable natively on macOS.
