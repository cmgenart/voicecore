/**
 * Echo cancellation: Krisp (optional) + browser AEC3 + software RMS/frequency gate.
 */

import { rmsFromFloat32, speechBandRatio } from "./util.js";

/**
 * @typedef {import('./config.js').VoiceCoreConfig} VoiceCoreConfig
 */

/** @type {{ ok: boolean, error?: string } | null} */
let krispProbeCache = null;

/**
 * Whether Krisp packages load in the browser (dev server must serve /npm/*).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function probeKrispPackages() {
  if (krispProbeCache) return krispProbeCache;
  try {
    const krispMod = await import("@livekit/krisp-noise-filter");
    await import("livekit-client");
    const supported = krispMod.isKrispNoiseFilterSupported?.();
    if (supported === false) {
      krispProbeCache = { ok: false, error: "Krisp not supported in this browser" };
      return krispProbeCache;
    }
    krispProbeCache = { ok: true };
  } catch (err) {
    krispProbeCache = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return krispProbeCache;
}

/** Call after npm install without reload to re-probe. */
export function clearKrispProbeCache() {
  krispProbeCache = null;
}

export class EchoGate {
  /**
   * @param {VoiceCoreConfig} config
   */
  constructor(config) {
    this.config = config;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {import('livekit-client').LocalAudioTrack|null} */
    this.krispTrack = null;
    /** @type {AudioContext|null} */
    this.krispAudioContext = null;
    this.mode = "browser";
    this.krispAttempted = false;
    this.krispError = null;
    this.outputLevel = 0;
    /** @type {AnalyserNode|null} */
    this.micAnalyserRef = null;
    /** @type {AnalyserNode|null} */
    this.outAnalyserRef = null;
  }

  /**
   * Acquire mic stream (Krisp path or browser AEC).
   * @returns {Promise<MediaStream>}
   */
  async init() {
    if (this.config.echo.preferKrisp) {
      const krispStream = await this.tryKrispStream();
      if (krispStream) {
        this.stream = krispStream;
        this.mode = "krisp";
        return this.stream;
      }
    }
    this.stream = await navigator.mediaDevices.getUserMedia(this.browserConstraints());
    this.mode = "browser";
    return this.stream;
  }

  browserConstraints() {
    return {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    };
  }

  /**
   * Optional Krisp via livekit-client track processor.
   * @returns {Promise<MediaStream|null>}
   */
  async tryKrispStream() {
    if (this.krispAttempted) return null;
    this.krispAttempted = true;
    try {
      const [krispMod, lkMod] = await Promise.all([
        import("@livekit/krisp-noise-filter"),
        import("livekit-client"),
      ]);
      if (krispMod.isKrispNoiseFilterSupported?.() === false) {
        throw new Error("Krisp not supported in this browser");
      }
      const KrispFactory = krispMod.KrispNoiseFilter ?? krispMod.default;
      const { createLocalAudioTrack } = lkMod;
      const track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      });

      // livekit-client requires AudioContext on the track before setProcessor (Krisp).
      const audioContext = new AudioContext();
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      track.setAudioContext(audioContext);
      this.krispAudioContext = audioContext;

      const processor =
        typeof KrispFactory === "function" ? KrispFactory() : KrispFactory;
      await track.setProcessor(processor);
      this.krispTrack = track;

      const processed =
        processor.processedTrack ?? track.mediaStream?.getAudioTracks()[0] ?? track.mediaStreamTrack;
      if (!processed || processed.readyState === "ended") {
        throw new Error("Krisp track produced no audio");
      }
      return new MediaStream([processed]);
    } catch (err) {
      this.krispError = err instanceof Error ? err.message : String(err);
      console.warn("[VoiceCore] Krisp unavailable, using browser AEC:", this.krispError);
      return null;
    }
  }

  getStream() {
    return this.stream;
  }

  getMode() {
    return this.mode;
  }

  /**
   * Wire analysers for frequency-assist echo gate.
   * @param {AnalyserNode|null} micAnalyser
   * @param {AnalyserNode|null} outAnalyser
   * @param {number} sampleRate
   */
  setAnalysers(micAnalyser, outAnalyser, sampleRate) {
    this.micAnalyserRef = micAnalyser;
    this.outAnalyserRef = outAnalyser;
    this.sampleRate = sampleRate;
  }

  /** @param {number} vol */
  setOutputLevel(vol) {
    this.outputLevel = vol;
  }

  /**
   * Software gate: forward mic during assistant playback only if above bleed threshold.
   * @param {Float32Array} channel
   * @param {boolean} assistantActive
   */
  shouldForwardMic(channel, assistantActive) {
    if (!assistantActive) return true;

    const micRms = rmsFromFloat32(channel);
    const echoEst = Math.max(this.outputLevel, this.config.echo.outputFloor);
    const rmsOk = micRms >= echoEst * this.config.echo.rmsMultiplier + this.config.echo.rmsOffset;

    if (!rmsOk) return false;

    if (
      this.config.echo.useFrequencyAssist &&
      this.micAnalyserRef &&
      this.outAnalyserRef
    ) {
      const ratio = speechBandRatio(
        this.micAnalyserRef,
        this.outAnalyserRef,
        this.sampleRate ?? 24000,
        this.config.echo.speechBandHz,
      );
      if (ratio < this.config.echo.freqRatioMin) return false;
    }

    return true;
  }

  /** Early mic permission without keeping stream. */
  async prepareMic() {
    const stream = await navigator.mediaDevices.getUserMedia(this.browserConstraints());
    stream.getTracks().forEach((t) => t.stop());
  }

  destroy() {
    if (this.krispTrack) {
      try {
        this.krispTrack.stopProcessor?.();
        this.krispTrack.stop();
      } catch {
        /* ignore */
      }
      this.krispTrack = null;
    }
    if (this.krispAudioContext) {
      this.krispAudioContext.close().catch(() => {});
      this.krispAudioContext = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.krispAttempted = false;
    this.micAnalyserRef = null;
    this.outAnalyserRef = null;
  }
}
