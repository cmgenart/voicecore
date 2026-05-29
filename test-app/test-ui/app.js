/**
 * VoiceCore test harness — tuning panel, hold pad, xAI session.
 */
import { VoiceCore, mergeConfig } from "../index.js";
import { createTuningPanel } from "./tuning-panel.js";
import { loadStoredOverrides, saveStoredOverrides } from "./tuning-spec.js";
import { createMicWaveform } from "./mic-waveform.js";

const STORAGE_KEY = "voicecore:test-api-key";

const els = {
  apiKey: document.getElementById("apiKey"),
  voice: document.getElementById("voice"),
  btnConnect: document.getElementById("btnConnect"),
  btnDisconnect: document.getElementById("btnDisconnect"),
  textInput: document.getElementById("textInput"),
  btnSend: document.getElementById("btnSend"),
  holdPad: document.getElementById("holdPad"),
  stateBadge: document.getElementById("stateBadge"),
  holdStatus: document.getElementById("holdStatus"),
  echoMode: document.getElementById("echoMode"),
  micGate: document.getElementById("micGate"),
  gateThreshold: document.getElementById("gateThreshold"),
  micMeter: document.getElementById("micMeter"),
  volMeter: document.getElementById("volMeter"),
  transcript: document.getElementById("transcript"),
  eventLog: document.getElementById("eventLog"),
};

const savedKey = localStorage.getItem(STORAGE_KEY);
if (savedKey) els.apiKey.value = savedKey;

/** @type {VoiceCore|null} */
let voice = null;
/** @type {ReturnType<typeof setInterval>|null} */
let uiTimer = null;

const tuningPanel = createTuningPanel({
  getVoice: () => voice,
  onAfterApply: (overrides) => {
    const g = overrides.speech?.micGain;
    if (typeof g === "number") micWaveform.setGain(g);
  },
});

document.getElementById("tuningMount")?.appendChild(tuningPanel.root);

const micWaveform = createMicWaveform(document.getElementById("micWaveformHost"), {
  onGainChange: (gain) => {
    const overrides = loadStoredOverrides();
    const merged = {
      ...overrides,
      speech: { ...overrides.speech, micGain: gain },
    };
    saveStoredOverrides(merged);
    if (voice?.isActive) voice.setConfig({ speech: { micGain: gain } });
    tuningPanel.syncGain?.(gain);
  },
  getGain: () => {
    const o = loadStoredOverrides();
    return o.speech?.micGain ?? 1;
  },
});

function logEvent(name, detail = {}) {
  const line = `[${new Date().toLocaleTimeString()}] ${name} ${JSON.stringify(detail)}\n`;
  els.eventLog.textContent = line + els.eventLog.textContent.slice(0, 8000);
}

function setConnected(on) {
  els.btnConnect.disabled = on;
  els.btnDisconnect.disabled = !on;
  els.textInput.disabled = !on;
  els.btnSend.disabled = !on;
  els.apiKey.disabled = on;
  els.voice.disabled = on;
  els.holdPad.disabled = !on;
}

function updateStateBadge(state) {
  els.stateBadge.textContent = state;
  els.stateBadge.className = `badge ${state.replace(/_/g, "_")}`;
}

function appendTranscript(role, text, final) {
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML = `<span class="role">${role}:</span>${escapeHtml(text)}${final ? "" : " …"}`;
  els.transcript.appendChild(line);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wireVoice(v) {
  const events = [
    "state-change",
    "user-speech-start",
    "user-speech-end",
    "barge-in",
    "barge-in-aborted",
    "ai-start",
    "ai-end",
    "hold-change",
    "transcript",
    "error",
  ];

  for (const type of events) {
    v.addEventListener(type, (e) => {
      logEvent(type, e.detail ?? {});
      if (type === "state-change") updateStateBadge(e.detail.to);
      if (type === "hold-change") {
        els.holdStatus.textContent = e.detail.active ? "holding" : "off";
        els.holdPad.classList.toggle("holding", e.detail.active);
      }
      if (type === "transcript" && e.detail.final) {
        appendTranscript(e.detail.role, e.detail.text, true);
      }
      if (type === "error") {
        appendTranscript("system", e.detail.message, true);
      }
    });
  }
}

function wireHoldPad() {
  const startHold = () => {
    if (!voice?.isActive) return;
    els.holdPad.classList.add("holding");
    voice.setHoldDeferred(true);
  };
  const endHold = () => {
    els.holdPad.classList.remove("holding");
    if (voice?.isActive) voice.setHoldDeferred(false);
  };

  els.holdPad.addEventListener("mousedown", startHold);
  els.holdPad.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startHold();
  });
  window.addEventListener("mouseup", endHold);
  window.addEventListener("touchend", endHold);
  window.addEventListener("touchcancel", endHold);
}

async function connect() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    alert("Enter your xAI API key.");
    return;
  }

  localStorage.setItem(STORAGE_KEY, apiKey);
  els.transcript.innerHTML = "";
  els.eventLog.textContent = "";

  const tuningOverrides = loadStoredOverrides();
  voice = new VoiceCore({ config: mergeConfig(tuningOverrides) });
  wireVoice(voice);

  els.btnConnect.disabled = true;
  try {
    await voice.prepareMic();
    await voice.connect({
      apiKey,
      voice: els.voice.value,
      instructions:
        "You are a friendly voice assistant in the VoiceCore test app. Greet the user briefly and keep replies short.",
      requestIntro: true,
    });
    voice.applySessionVad();
    setConnected(true);
    els.echoMode.textContent = voice.getEchoMode();
    tuningPanel.onSessionChange();
    tuningPanel.refreshKrispNote();
    startUiLoop();
    micWaveform.setGain(voice.getDebugInfo().micGain ?? 1);
    micWaveform.start(() => (voice?.isActive ? voice.getMicMonitorFrame() : null));
    logEvent("connected", { echo: voice.getEchoMode() });
  } catch (err) {
    voice = null;
    setConnected(false);
    logEvent("connect_failed", { message: String(err?.message || err) });
    alert(err?.message || err);
  }
}

async function disconnect() {
  micWaveform.stop();
  stopUiLoop();
  if (voice) {
    await voice.disconnect();
    voice = null;
  }
  setConnected(false);
  updateStateBadge("idle");
  els.holdStatus.textContent = "off";
  els.holdPad.classList.remove("holding");
  els.echoMode.textContent = "—";
  els.micGate.textContent = "off";
  els.gateThreshold.textContent = "—";
  els.micMeter.value = 0;
  els.volMeter.value = 0;
  tuningPanel.refreshKrispNote();
}

function startUiLoop() {
  stopUiLoop();
  uiTimer = setInterval(() => {
    if (!voice) return;
    const levels = voice.getLevels();
    const debug = voice.getDebugInfo();
    els.micMeter.value = levels.mic;
    els.volMeter.value = levels.vol;
    els.micGate.textContent = debug.micGateOpen ? "streaming" : "gated";
    els.gateThreshold.textContent = debug.speechGateThreshold.toFixed(3);
    els.echoMode.textContent = debug.echoMode;
  }, 100);
}

function stopUiLoop() {
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = null;
}

wireHoldPad();
els.btnConnect.addEventListener("click", () => connect());
els.btnDisconnect.addEventListener("click", () => disconnect());
els.btnSend.addEventListener("click", () => {
  const t = els.textInput.value.trim();
  if (!t || !voice) return;
  voice.sendText(t);
  appendTranscript("user", t, true);
  els.textInput.value = "";
});
els.textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.btnSend.click();
});
