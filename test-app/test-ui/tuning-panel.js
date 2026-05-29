/**
 * Collapsible tuning drawer — sliders, presets, export.
 */
import {
  TUNING_SPECS,
  TUNING_PRESETS,
  TUNING_STORAGE_KEY,
  getPathValue,
  patchAtPath,
  overridesFromPaths,
  loadStoredOverrides,
  saveStoredOverrides,
} from "./tuning-spec.js";
import { defaultConfig, mergeConfig } from "../config.js";
import { probeKrispPackages, clearKrispProbeCache } from "../echo-gate.js";

const DEBOUNCE_MS = 200;

/**
 * @param {{
 *   getVoice: () => import('../index.js').VoiceCore | null,
 *   onConfigChange?: (overrides: Record<string, unknown>) => void,
 *   onAfterApply?: (overrides: Record<string, unknown>) => void,
 * }} hooks
 */
export function createTuningPanel(hooks) {
  const root = document.createElement("aside");
  root.className = "tuning-drawer";
  root.innerHTML = `
    <header class="tuning-header">
      <button type="button" class="tuning-toggle" aria-expanded="true" title="Collapse tuning">Tuning</button>
      <span class="tuning-apply-hint" id="tuningApplyHint"></span>
    </header>
    <div class="tuning-body">
      <div class="tuning-presets">
        <button type="button" data-preset="default">Default</button>
        <button type="button" data-preset="patient" class="preset-accent">Patient</button>
        <button type="button" data-preset="snappy">Snappy</button>
        <button type="button" data-preset="stable" class="preset-accent">Stable</button>
      </div>
      <div class="tuning-toolbar">
        <label class="toggle-chip" title="Requires Krisp packages + reconnect">
          <input type="checkbox" id="preferKrisp" />
          <span>Krisp</span>
        </label>
        <label class="toggle-chip" title="Frequency-based echo gate assist">
          <input type="checkbox" id="freqAssist" checked />
          <span>Freq assist</span>
        </label>
      </div>
      <p class="tuning-krisp-note" id="krispNote"></p>
      <div class="tuning-sliders"></div>
      <p class="tuning-actions-help">
        Sliders auto-apply locally. <strong>Push VAD</strong> sends Listen/Barge thresholds to xAI (which one depends on whether the AI is speaking right now).
      </p>
      <div class="tuning-actions">
        <button type="button" id="btnApplyVad" title="session.update turn_detection on the live WebSocket">Push VAD</button>
        <button type="button" id="btnExportConfig" title="Copy tuning overrides JSON">Copy JSON</button>
        <button type="button" id="btnResetTuning">Reset</button>
      </div>
    </div>
  `;

  const sliderHost = /** @type {HTMLElement} */ (root.querySelector(".tuning-sliders"));
  const applyHint = /** @type {HTMLElement} */ (root.querySelector("#tuningApplyHint"));
  const krispNote = /** @type {HTMLElement} */ (root.querySelector("#krispNote"));
  const preferKrisp = /** @type {HTMLInputElement} */ (root.querySelector("#preferKrisp"));
  const freqAssist = /** @type {HTMLInputElement} */ (root.querySelector("#freqAssist"));

  /** @type {Record<string, number>} */
  let valuesByPath = {};
  /** @type {ReturnType<typeof setTimeout>|null} */
  let debounceTimer = null;

  let mergedBase = mergeConfig(loadStoredOverrides());

  function buildSliders() {
    sliderHost.innerHTML = "";
    let section = "";
    /** @type {HTMLElement|null} */
    let sectionEl = null;

    for (const spec of TUNING_SPECS) {
      if (spec.section !== section) {
        section = spec.section;
        sectionEl = document.createElement("div");
        sectionEl.className = "tuning-section";
        const h = document.createElement("div");
        h.className = "tuning-section-title";
        h.textContent = section;
        sectionEl.appendChild(h);
        sliderHost.appendChild(sectionEl);
      }

      const val = getPathValue(mergedBase, spec.path);
      valuesByPath[spec.path] = val;
      const displayLabel = spec.shortLabel ?? spec.label;
      const tip = spec.hint ? `${spec.label} — ${spec.hint}` : spec.label;

      const row = document.createElement("div");
      row.className = "tuning-row";
      row.title = tip;
      row.innerHTML = `
        <div class="tuning-row-head">
          <span class="tuning-label">${displayLabel}</span>
          <span class="tuning-value" data-path="${spec.path}">${spec.format ? spec.format(val) : val}</span>
        </div>
        <input type="range" data-path="${spec.path}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${val}" />
      `;
      sectionEl?.appendChild(row);
    }

    sliderHost.querySelectorAll('input[type="range"]').forEach((input) => {
      input.addEventListener("input", onSliderInput);
    });
  }

  function onSliderInput(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const path = input.dataset.path;
    if (!path) return;
    const value = Number(input.value);
    valuesByPath[path] = value;
    const spec = TUNING_SPECS.find((s) => s.path === path);
    const label = root.querySelector(`.tuning-value[data-path="${path}"]`);
    if (label && spec?.format) label.textContent = spec.format(value);

    scheduleApply();
  }

  function scheduleApply() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyNow, DEBOUNCE_MS);
  }

  /** Partial overrides only (safe for localStorage + setConfig). */
  function getPartialForStorage() {
    return {
      ...overridesFromPaths(valuesByPath),
      echo: {
        preferKrisp: preferKrisp.checked,
        useFrequencyAssist: freqAssist.checked,
      },
    };
  }

  function applyNow() {
    const overrides = getPartialForStorage();
    saveStoredOverrides(overrides);
    mergedBase = mergeConfig(overrides);
    hooks.onConfigChange?.(overrides);
    hooks.onAfterApply?.(overrides);

    const voice = hooks.getVoice();
    if (voice?.isActive) {
      voice.setConfig(overrides);
      voice.applySessionVad();
      applyHint.textContent = "Live — VAD updated";
      applyHint.className = "tuning-apply-hint ok";
    } else {
      applyHint.textContent = "Saved — connect to apply VAD";
      applyHint.className = "tuning-apply-hint";
    }
  }

  function applyPreset(name) {
    const preset = TUNING_PRESETS[name] ?? {};
    saveStoredOverrides(preset);
    mergedBase = mergeConfig(preset);
    buildSliders();
    preferKrisp.checked = mergedBase.echo.preferKrisp;
    freqAssist.checked = mergedBase.echo.useFrequencyAssist;
    applyNow();
  }

  async function updateKrispNote() {
    const voice = hooks.getVoice();
    const probe = await probeKrispPackages();
    const connected = Boolean(voice?.isActive);
    const info = voice?.getEchoInfo?.();

    if (connected && info) {
      if (info.mode === "krisp") {
        krispNote.textContent = "Echo path: krisp (Krisp noise filter active).";
        krispNote.className = "tuning-krisp-note ok";
        return;
      }
      if (info.preferKrisp && info.krispError) {
        krispNote.textContent = `Echo path: browser (AEC3). Krisp failed: ${shortErr(info.krispError)} — disconnect and connect again after updating the app.`;
        krispNote.className = "tuning-krisp-note warn";
        return;
      }
      if (info.preferKrisp) {
        krispNote.textContent =
          "Echo path: browser (AEC3). Krisp is enabled — disconnect and connect again if you just installed packages.";
        krispNote.className = "tuning-krisp-note";
        return;
      }
      krispNote.textContent = "Echo path: browser (AEC3). Enable Krisp checkbox and reconnect to try Krisp.";
      krispNote.className = "tuning-krisp-note";
      return;
    }

    if (!probe.ok) {
      const hint = probe.error?.includes("Failed to fetch")
        ? "Packages not served — restart the app (npm start) from modules/voicecore/test-app/ after npm install."
        : `npm install in modules/voicecore/test-app/ — ${shortErr(probe.error || "not found")}`;
      krispNote.textContent = `Echo path: (connect to see). ${hint}`;
      krispNote.className = "tuning-krisp-note warn";
      return;
    }

    const krispOn = preferKrisp.checked;
    krispNote.textContent = krispOn
      ? "Krisp packages: OK. Connect to use Krisp (echo path shows after connect)."
      : "Krisp packages: OK. Enable Krisp + connect to use; otherwise browser AEC3.";
    krispNote.className = "tuning-krisp-note ok";
  }

  /** @param {string} msg */
  function shortErr(msg) {
    return msg.length > 72 ? `${msg.slice(0, 69)}…` : msg;
  }

  buildSliders();
  preferKrisp.checked = mergedBase.echo.preferKrisp;
  freqAssist.checked = mergedBase.echo.useFrequencyAssist;
  updateKrispNote();

  preferKrisp.addEventListener("change", () => {
    clearKrispProbeCache();
    scheduleApply();
    updateKrispNote();
  });
  freqAssist.addEventListener("change", scheduleApply);

  root.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyPreset(/** @type {HTMLElement} */ (btn).dataset.preset ?? "default");
    });
  });

  root.querySelector("#btnApplyVad")?.addEventListener("click", () => {
    const voice = hooks.getVoice();
    if (voice?.applySessionVad()) {
      applyHint.textContent = "VAD pushed to server";
      applyHint.className = "tuning-apply-hint ok";
    } else {
      applyHint.textContent = "Connect first";
      applyHint.className = "tuning-apply-hint warn";
    }
  });

  root.querySelector("#btnExportConfig")?.addEventListener("click", () => {
    const json = JSON.stringify(getPartialForStorage(), null, 2);
    copyConfigToClipboard(json);
  });

  root.querySelector("#btnResetTuning")?.addEventListener("click", () => {
    localStorage.removeItem(TUNING_STORAGE_KEY);
    applyPreset("default");
  });

  const toggleBtn = root.querySelector(".tuning-toggle");
  const body = root.querySelector(".tuning-body");
  const open = localStorage.getItem("voicecore:tuning-open") !== "0";
  root.classList.toggle("collapsed", !open);
  toggleBtn?.setAttribute("aria-expanded", String(open));

  toggleBtn?.addEventListener("click", () => {
    const collapsed = root.classList.toggle("collapsed");
    localStorage.setItem("voicecore:tuning-open", collapsed ? "0" : "1");
    toggleBtn.setAttribute("aria-expanded", String(!collapsed));
  });

  /** Keep chart Gain slider in sync with tuning panel. */
  function syncGain(gain) {
    const input = sliderHost.querySelector('input[data-path="speech.micGain"]');
    if (!input) return;
    /** @type {HTMLInputElement} */ (input).value = String(gain);
    valuesByPath["speech.micGain"] = gain;
    const label = root.querySelector('.tuning-value[data-path="speech.micGain"]');
    const spec = TUNING_SPECS.find((s) => s.path === "speech.micGain");
    if (label && spec?.format) label.textContent = spec.format(gain);
  }

  return {
    root,
    getOverrides: () => getPartialForStorage(),
    syncGain,
    refreshKrispNote: updateKrispNote,
    onSessionChange() {
      updateKrispNote();
    },
  };
}

/**
 * Clipboard API often fails in Electron; fall back to execCommand + modal.
 * @param {string} json
 */
function copyConfigToClipboard(json) {
  const hint = document.querySelector("#tuningApplyHint");
  const setHint = (text, cls) => {
    if (!hint) return;
    hint.textContent = text;
    hint.className = `tuning-apply-hint ${cls}`;
  };

  const tryExec = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = json;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const finish = (ok) => {
    if (ok) {
      setHint("JSON copied", "ok");
      return;
    }
    showCopyModal(json);
    setHint("Select JSON in dialog → Ctrl+C", "warn");
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(json)
      .then(() => finish(true))
      .catch(() => finish(tryExec()));
    return;
  }
  finish(tryExec());
}

/** @param {string} json */
function showCopyModal(json) {
  const existing = document.getElementById("voicecore-copy-modal");
  existing?.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "voicecore-copy-modal";
  backdrop.className = "copy-modal-backdrop";
  backdrop.innerHTML = `
    <div class="copy-modal" role="dialog" aria-labelledby="copyModalTitle">
      <header class="copy-modal-header">
        <h3 id="copyModalTitle">Tuning overrides (JSON)</h3>
        <button type="button" class="copy-modal-close" aria-label="Close">×</button>
      </header>
      <p class="copy-modal-hint">Clipboard blocked — select all below, then Ctrl+C (Cmd+C on Mac).</p>
      <textarea class="copy-modal-text" readonly spellcheck="false"></textarea>
      <div class="copy-modal-actions">
        <button type="button" class="copy-modal-select">Select all</button>
        <button type="button" class="copy-modal-close-btn">Close</button>
      </div>
    </div>
  `;

  const ta = /** @type {HTMLTextAreaElement} */ (backdrop.querySelector(".copy-modal-text"));
  ta.value = json;

  const close = () => backdrop.remove();
  backdrop.querySelector(".copy-modal-close")?.addEventListener("click", close);
  backdrop.querySelector(".copy-modal-close-btn")?.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector(".copy-modal-select")?.addEventListener("click", () => {
    ta.focus();
    ta.select();
  });

  document.body.appendChild(backdrop);
  requestAnimationFrame(() => {
    ta.focus();
    ta.select();
  });
}
