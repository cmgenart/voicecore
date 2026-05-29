/**
 * PCM and encoding helpers for xAI Realtime.
 */

/**
 * @param {Float32Array} float32
 * @returns {Uint8Array}
 */
export function floatTo16BitPCM(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * @param {string} base64
 * @returns {Float32Array}
 */
export function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
  return float32;
}

/**
 * @param {Float32Array} buf
 * @returns {number}
 */
export function rmsFromFloat32(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

/**
 * @param {AnalyserNode} analyser
 * @returns {number}
 */
export function rmsFromAnalyser(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  return rmsFromFloat32(buf);
}

/**
 * Speech-band energy ratio mic vs output (for echo gate assist).
 * @param {AnalyserNode|null} micAnalyser
 * @param {AnalyserNode|null} outAnalyser
 * @param {number} sampleRate
 * @param {[number, number]} bandHz
 * @returns {number} ratio or 1 if unavailable
 */
export function speechBandRatio(micAnalyser, outAnalyser, sampleRate, bandHz) {
  if (!micAnalyser || !outAnalyser) return 1;
  const micE = bandEnergy(micAnalyser, sampleRate, bandHz);
  const outE = bandEnergy(outAnalyser, sampleRate, bandHz);
  if (outE < 0.001) return micE > 0.01 ? 2 : 1;
  return micE / outE;
}

/**
 * @param {AnalyserNode} analyser
 * @param {number} sampleRate
 * @param {[number, number]} bandHz
 */
function bandEnergy(analyser, sampleRate, bandHz) {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const [fLo, fHi] = bandHz;
  const binLo = Math.max(0, Math.floor((fLo * analyser.fftSize) / sampleRate));
  const binHi = Math.min(data.length - 1, Math.floor((fHi * analyser.fftSize) / sampleRate));
  let sum = 0;
  for (let i = binLo; i <= binHi; i++) sum += data[i];
  return binHi > binLo ? sum / (binHi - binLo + 1) / 255 : 0;
}
