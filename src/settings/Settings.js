/**
 * Settings.js
 *
 * Manages persistent user preferences using localStorage.
 *
 * All methods are static — no instantiation needed.
 * Provides typed accessors with input validation.
 */

/** localStorage key namespace */
const KEY = {
  DEVICE_IP:        'gesturelight:deviceIp',
  CAMERA_DEVICE_ID: 'gesturelight:cameraDeviceId',
  LAST_BRIGHTNESS:  'gesturelight:lastBrightness',
};

/** Default ESP32 IP address */
export const DEFAULT_IP = '192.168.1.23';

/**
 * Validate a device IP address or hostname string.
 *
 * Accepts:
 *   - Standard IPv4 (e.g. "192.168.1.23")
 *   - Hostnames (e.g. "esp32.local")
 *   - "localhost"
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isValidAddress(ip) {
  if (typeof ip !== 'string' || ip.trim().length === 0) return false;
  const v = ip.trim();

  // Validate IPv4
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = ipv4.exec(v);
  if (m) {
    return m.slice(1).every(octet => parseInt(octet, 10) <= 255);
  }

  // Validate hostname (RFC 952 / 1123)
  const hostname = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]{0,61}[a-zA-Z0-9])?$/;
  return hostname.test(v);
}

export class Settings {
  // ─── Device IP ────────────────────────────────────────────

  /**
   * Return the saved device IP, or the factory default.
   * @returns {string}
   */
  static getDeviceIP() {
    const saved = localStorage.getItem(KEY.DEVICE_IP);
    return isValidAddress(saved) ? saved.trim() : DEFAULT_IP;
  }

  /**
   * Save a new device IP address.
   * Returns false if the address is invalid (caller should show error).
   *
   * @param {string} ip
   * @returns {boolean} true if saved, false if invalid
   */
  static setDeviceIP(ip) {
    if (!isValidAddress(ip)) return false;
    localStorage.setItem(KEY.DEVICE_IP, ip.trim());
    return true;
  }

  // ─── Camera ───────────────────────────────────────────────

  /**
   * Return the saved camera deviceId, or null if none was saved.
   * @returns {string | null}
   */
  static getCameraDeviceId() {
    return localStorage.getItem(KEY.CAMERA_DEVICE_ID) ?? null;
  }

  /**
   * Save the selected camera deviceId.
   * Pass null or empty string to clear the preference.
   *
   * @param {string | null} deviceId
   */
  static setCameraDeviceId(deviceId) {
    if (deviceId) {
      localStorage.setItem(KEY.CAMERA_DEVICE_ID, deviceId);
    } else {
      localStorage.removeItem(KEY.CAMERA_DEVICE_ID);
    }
  }

  // ─── Brightness ───────────────────────────────────────────

  /**
   * Return the last known brightness value (0–255).
   * Used to restore brightness after a WebSocket reconnect.
   * @returns {number}
   */
  static getLastBrightness() {
    const raw = parseInt(localStorage.getItem(KEY.LAST_BRIGHTNESS) ?? '0', 10);
    if (isNaN(raw)) return 0;
    return Math.max(0, Math.min(255, raw));
  }

  /**
   * Persist the current brightness value.
   * @param {number} value - Integer 0–255
   */
  static setLastBrightness(value) {
    const clamped = Math.max(0, Math.min(255, Math.round(value)));
    localStorage.setItem(KEY.LAST_BRIGHTNESS, String(clamped));
  }
}
