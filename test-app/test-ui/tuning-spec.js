/**
 * Tuning control definitions and presets for VoiceCore test UI.
 */
import { defaultConfig } from "../config.js";

/** @typedef {{ path: string, label: string, shortLabel?: string, section: string, min: number, max: number, step: number, hint?: string, format?: (v: number) => string }} TuningSpec */

/** @type {TuningSpec[]} */
export const TUNING_SPECS = [
  {
    path: "vad.silenceDurationMs",
    label: "Silence before end-of-turn",
    shortLabel: "Silence",
    section: "VAD",
    min: 800,
    max: 3500,
    step: 50,
    hint: "Higher = tolerate longer mid-sentence pauses",
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    path: "vad.prefixPaddingMs",
    label: "Prefix padding",
    shortLabel: "Prefix",
    section: "VAD",
    min: 200,
    max: 800,
    step: 50,
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    path: "vad.thresholdListen",
    label: "Listen threshold",
    shortLabel: "Listen",
    section: "VAD",
    min: 0.75,
    max: 0.95,
    step: 0.01,
    hint: "Lower = more sensitive to quiet speech",
    format: (v) => v.toFixed(2),
  },
  {
    path: "vad.thresholdBargeIn",
    label: "Barge-in threshold",
    shortLabel: "Barge VAD",
    section: "VAD",
    min: 0.8,
    max: 0.98,
    step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    path: "speech.micGain",
    label: "Mic gain",
    shortLabel: "Gain",
    section: "Speech gate",
    min: 0.5,
    max: 3,
    step: 0.05,
    hint: "Boost quiet mics before local gate (not server VAD)",
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    path: "speech.hangoverMs",
    label: "Speech hangover",
    shortLabel: "Hangover",
    section: "Speech gate",
    min: 400,
    max: 2500,
    step: 50,
    hint: "Keep sending audio after volume drops",
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    path: "speech.preRollMs",
    label: "Pre-roll",
    section: "Speech gate",
    min: 100,
    max: 600,
    step: 25,
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    path: "speech.minRms",
    label: "Min RMS",
    section: "Speech gate",
    min: 0.01,
    max: 0.04,
    step: 0.001,
    hint: "Lower = quieter word endings still uplink",
    format: (v) => v.toFixed(3),
  },
  {
    path: "speech.noiseMargin",
    label: "Noise margin",
    section: "Speech gate",
    min: 2,
    max: 5,
    step: 0.1,
    format: (v) => v.toFixed(1),
  },
  {
    path: "utterance.latchMs",
    label: "Utterance latch",
    shortLabel: "Latch",
    section: "Utterance",
    min: 1000,
    max: 4000,
    step: 100,
    hint: "Stream through pauses while server thinks you're still talking",
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    path: "echo.rmsMultiplier",
    label: "Echo RMS multiplier",
    shortLabel: "RMS ×",
    section: "Echo",
    min: 1,
    max: 2,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    path: "echo.rmsOffset",
    label: "Echo RMS offset",
    shortLabel: "RMS +",
    section: "Echo",
    min: 0.03,
    max: 0.12,
    step: 0.01,
    format: (v) => v.toFixed(2),
  },
  {
    path: "echo.freqRatioMin",
    label: "Speech band ratio min",
    shortLabel: "Band ratio",
    section: "Echo",
    min: 1,
    max: 2,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    path: "barge.localConfirmMs",
    label: "Local barge confirm",
    shortLabel: "Local barge",
    section: "Barge-in",
    min: 50,
    max: 300,
    step: 10,
    format: (v) => `${Math.round(v)} ms`,
  },
  {
    path: "barge.falseRecoveryMs",
    label: "False barge recovery",
    shortLabel: "False recovery",
    section: "Barge-in",
    min: 300,
    max: 1200,
    step: 50,
    format: (v) => `${Math.round(v)} ms`,
  },
];

export const TUNING_STORAGE_KEY = "voicecore:tuning-overrides";

/** @type {Record<string, Partial<import('../config.js').VoiceCoreConfig>>} */
export const TUNING_PRESETS = {
  /** Same as src/config.js defaultConfig tuning (Stable baseline). */
  default: {
    vad: {
      silenceDurationMs: 1500,
      prefixPaddingMs: 400,
      thresholdListen: 0.85,
      thresholdBargeIn: 0.92,
    },
    speech: {
      micGain: 1,
      hangoverMs: 1200,
      preRollMs: 350,
      minRms: 0.022,
      noiseMargin: 3.2,
    },
    utterance: { latchMs: 2000 },
    echo: {
      rmsMultiplier: 1.35,
      rmsOffset: 0.07,
      freqRatioMin: 1.15,
    },
    barge: {
      localConfirmMs: 80,
      falseRecoveryMs: 600,
    },
  },
  patient: {
    vad: {
      silenceDurationMs: 2200,
      prefixPaddingMs: 500,
      thresholdListen: 0.82,
      thresholdBargeIn: 0.86,
    },
    speech: {
      micGain: 1.5,
      hangoverMs: 1600,
      preRollMs: 400,
      minRms: 0.018,
      noiseMargin: 2.8,
    },
    utterance: { latchMs: 2800 },
  },
  snappy: {
    vad: {
      silenceDurationMs: 1200,
      prefixPaddingMs: 300,
      thresholdListen: 0.88,
      thresholdBargeIn: 0.9,
    },
    speech: {
      hangoverMs: 900,
      preRollMs: 300,
      minRms: 0.024,
      noiseMargin: 3.4,
    },
    utterance: { latchMs: 1500 },
  },
  /** Values that worked well in manual testing (screenshot baseline). */
  stable: {
    vad: {
      silenceDurationMs: 1500,
      prefixPaddingMs: 400,
      thresholdListen: 0.85,
      thresholdBargeIn: 0.92,
    },
    speech: {
      micGain: 1,
      hangoverMs: 1200,
      preRollMs: 350,
      minRms: 0.022,
      noiseMargin: 3.2,
    },
    utterance: { latchMs: 2000 },
    echo: {
      rmsMultiplier: 1.35,
      rmsOffset: 0.07,
      freqRatioMin: 1.15,
    },
    barge: {
      localConfirmMs: 80,
      falseRecoveryMs: 600,
    },
  },
};

/**
 * @param {import('../config.js').VoiceCoreConfig} config
 * @param {string} path e.g. "vad.silenceDurationMs"
 */
export function getPathValue(config, path) {
  const parts = path.split(".");
  let cur = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (config));
  for (const p of parts) {
    cur = /** @type {Record<string, unknown>} */ (cur[p]);
  }
  return Number(cur);
}

/**
 * @param {import('../config.js').VoiceCoreConfig} config
 * @param {string} path
 * @param {number} value
 * @returns {Partial<import('../config.js').VoiceCoreConfig>}
 */
export function patchAtPath(config, path, value) {
  const parts = path.split(".");
  const root = {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = {};
    cur = /** @type {Record<string, unknown>} */ (cur[parts[i]]);
  }
  cur[parts[parts.length - 1]] = value;
  return /** @type {Partial<import('../config.js').VoiceCoreConfig>} */ (root);
}

/**
 * Build partial config overrides from all slider values.
 * @param {Record<string, number>} valuesByPath
 */
export function overridesFromPaths(valuesByPath) {
  let partial = {};
  for (const [path, value] of Object.entries(valuesByPath)) {
    partial = mergeConfig(patchAtPath(defaultConfig, path, value), partial);
  }
  return partial;
}

export function loadStoredOverrides() {
  try {
    const raw = localStorage.getItem(TUNING_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveStoredOverrides(overrides) {
  localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(overrides));
}
