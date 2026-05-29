/**
 * VoiceCore default thresholds and settings.
 * Merge overrides via VoiceCore constructor options.config.
 */

export const SAMPLE_RATE = 24000;
export const PARAM_FPS = 30;
export const MODEL = "grok-voice-latest";

/** @type {import('./config.js').VoiceCoreConfig} */
export const defaultConfig = {
  sampleRate: SAMPLE_RATE,
  processorBufferSize: 4096,
  allowedInputRates: [8000, 16000, 22050, 24000, 32000, 44100, 48000],

  vad: {
    type: "server_vad",
    thresholdListen: 0.85,
    /** Server VAD while assistant speaks — lower = easier interrupt (0.90–0.94 typical). */
    thresholdBargeIn: 0.92,
    silenceDurationMs: 1500,
    prefixPaddingMs: 400,
  },

  speech: {
    /** Software gain after capture (1 = unity). Does not affect server VAD threshold. */
    micGain: 1,
    minRms: 0.022,
    noiseMargin: 3.2,
    hangoverMs: 1200,
    preRollMs: 350,
  },

  utterance: {
    latchMs: 2000,
  },

  thinking: {
    minMs: 300,
  },

  echo: {
    rmsMultiplier: 1.35,
    rmsOffset: 0.07,
    outputFloor: 0.04,
    useFrequencyAssist: true,
    freqRatioMin: 1.15,
    speechBandHz: [300, 3400],
    preferKrisp: true,
  },

  barge: {
    localConfirmMs: 80,
    serverConfirmMs: 1200,
    falseRecoveryMs: 600,
    localFrameMs: 85,
  },

  playback: {
    volDecayPerSec: 0.5,
  },

  session: {
    secretExpiresSec: 300,
    requestIntro: true,
    defaultVoice: "eve",
    defaultInstructions:
      "You are a helpful voice assistant. Keep replies concise and conversational.",
  },
};

/**
 * Deep-merge user overrides onto defaults or an existing config.
 * @param {Partial<VoiceCoreConfig>} [overrides]
 * @param {VoiceCoreConfig} [base]
 * @returns {VoiceCoreConfig}
 */
export function mergeConfig(overrides, base) {
  const seed = base ? structuredClone(base) : structuredClone(defaultConfig);
  if (!overrides) return seed;
  return deepMerge(seed, overrides);
}

/**
 * @param {VoiceCoreConfig} cfg
 * @param {boolean} assistantSpeaking
 */
export function vadSettings(cfg, assistantSpeaking) {
  return {
    type: cfg.vad.type,
    threshold: assistantSpeaking ? cfg.vad.thresholdBargeIn : cfg.vad.thresholdListen,
    prefix_padding_ms: cfg.vad.prefixPaddingMs,
    silence_duration_ms: cfg.vad.silenceDurationMs,
  };
}

/**
 * @typedef {Object} VoiceCoreConfig
 * @property {number} sampleRate
 * @property {number} processorBufferSize
 * @property {number[]} allowedInputRates
 * @property {{ type: string, thresholdListen: number, thresholdBargeIn: number, silenceDurationMs: number, prefixPaddingMs: number }} vad
 * @property {{ micGain: number, minRms: number, noiseMargin: number, hangoverMs: number, preRollMs: number }} speech
 * @property {{ latchMs: number }} utterance
 * @property {{ minMs: number }} thinking
 * @property {{ rmsMultiplier: number, rmsOffset: number, outputFloor: number, useFrequencyAssist: boolean, freqRatioMin: number, speechBandHz: [number, number], preferKrisp: boolean }} echo
 * @property {{ localConfirmMs: number, serverConfirmMs: number, falseRecoveryMs: number, localFrameMs: number }} barge
 * @property {{ volDecayPerSec: number }} playback
 * @property {{ secretExpiresSec: number, requestIntro: boolean, defaultVoice: string, defaultInstructions: string }} session
 */

/** @param {Record<string, unknown>} target */
/** @param {Record<string, unknown>} source */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      deepMerge(/** @type {Record<string, unknown>} */ (tv), /** @type {Record<string, unknown>} */ (sv));
    } else {
      target[key] = sv;
    }
  }
  return target;
}
