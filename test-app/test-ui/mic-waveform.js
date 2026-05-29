/**
 * Sliding mic level chart — 10 bars/sec, freezes when quiet, shows gate threshold + cuts.
 */

const BARS_PER_SEC = 10;
const TICK_MS = 1000 / BARS_PER_SEC;
const DISPLAY_MAX = 0.35;
/** Consecutive sub-gate samples before chart pauses */
const PAUSE_BELOW_GATE_TICKS = 4;

/**
 * @typedef {{ rms: number, threshold: number, speechPassed: boolean, gateOpen: boolean, canSend: boolean, cut?: boolean }} WaveBar
 */

/**
 * @param {HTMLElement} host
 * @param {{ onGainChange?: (gain: number) => void, getGain?: () => number }} [hooks]
 */
export function createMicWaveform(host, hooks = {}) {
  host.className = "mic-waveform";
  host.innerHTML = `
    <div class="waveform-head">
      <span class="waveform-title">Mic level (local gate)</span>
      <label class="waveform-gain">
        Gain
        <input type="range" id="micGainSlider" min="0.5" max="3" step="0.05" value="1" />
        <span id="micGainVal">1.00×</span>
      </label>
    </div>
    <p class="waveform-note"><strong>Gain</strong> raises/lowers bars only. The yellow <strong>gate</strong> line moves with <strong>Min RMS</strong> / <strong>Noise margin</strong> (not Gain). <strong>Listen</strong> is server VAD only.</p>
    <div class="waveform-legend">
      <span><i class="lg lg-stream"></i> streaming</span>
      <span><i class="lg lg-cut"></i> cut</span>
      <span><i class="lg lg-below"></i> below gate</span>
      <span class="lg-thresh">— gate threshold</span>
    </div>
    <canvas class="waveform-canvas" width="640" height="100"></canvas>
    <div class="waveform-status" id="waveformStatus">Waiting for mic…</div>
  `;

  const canvas = /** @type {HTMLCanvasElement} */ (host.querySelector(".waveform-canvas"));
  const ctx = canvas.getContext("2d");
  const statusEl = host.querySelector("#waveformStatus");
  const gainSlider = /** @type {HTMLInputElement} */ (host.querySelector("#micGainSlider"));
  const gainVal = host.querySelector("#micGainVal");

  /** @type {WaveBar[]} */
  let bars = [];
  let paused = true;
  let lastTick = 0;
  let belowGateStreak = 0;
  let running = false;
  /** @type {ReturnType<typeof setInterval>|null} */
  let pollTimer = null;

  const maxBars = () => Math.max(40, Math.floor(canvas.clientWidth / 6));

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(100 * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  gainSlider.addEventListener("input", () => {
    const g = Number(gainSlider.value);
    gainVal.textContent = `${g.toFixed(2)}×`;
    hooks.onGainChange?.(g);
  });

  if (hooks.getGain) {
    const g = hooks.getGain();
    gainSlider.value = String(g);
    gainVal.textContent = `${g.toFixed(2)}×`;
  }

  /**
   * @param {() => { rms: number, threshold: number, speechPassed: boolean, gateOpen: boolean, canSend: boolean, assistantActive?: boolean } | null} sampleFn
   */
  function start(sampleFn) {
    stop();
    running = true;
    paused = true;
    bars = [];
    belowGateStreak = 0;
    lastTick = 0;
    resizeCanvas();
    pollTimer = setInterval(() => {
      if (!running) return;
      const s = sampleFn();
      if (!s) return;

      const now = performance.now();

      if (!s.speechPassed) {
        belowGateStreak += 1;
      } else {
        belowGateStreak = 0;
      }

      if (belowGateStreak >= PAUSE_BELOW_GATE_TICKS) {
        paused = true;
        statusEl.textContent = `Paused — below gate (RMS ${s.rms.toFixed(3)} < ${s.threshold.toFixed(3)}). Raise Gain or lower Min RMS.`;
        draw(s.threshold);
        return;
      }

      if (paused) {
        paused = false;
        lastTick = now;
      }

      if (now - lastTick < TICK_MS) {
        draw(s.threshold);
        return;
      }

      lastTick = now;
      const cut = s.speechPassed && !s.gateOpen && s.canSend;
      bars.push({
        rms: s.rms,
        threshold: s.threshold,
        speechPassed: s.speechPassed,
        gateOpen: s.gateOpen,
        canSend: s.canSend,
        cut,
      });

      const cap = maxBars();
      while (bars.length > cap) bars.shift();

      const streamLabel = !s.canSend
        ? "hold / off"
        : s.gateOpen
          ? "uplink streaming"
          : s.speechPassed
            ? "gated (cut)"
            : "below gate";
      statusEl.textContent = `RMS ${s.rms.toFixed(3)} · gate ${s.threshold.toFixed(3)} · ${streamLabel}${s.assistantActive ? " · AI playing" : ""}`;
      draw(s.threshold);
    }, 50);
  }

  function stop() {
    running = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    bars = [];
    belowGateStreak = 0;
    paused = true;
    statusEl.textContent = "Stopped";
    draw(0);
  }

  /**
   * @param {number} threshold
   */
  function draw(threshold = 0) {
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = 100;
    ctx.clearRect(0, 0, w, h);

    const cap = maxBars();
    const barW = w / cap;
    const threshY = h - (Math.min(threshold, DISPLAY_MAX) / DISPLAY_MAX) * (h - 8) - 4;

    ctx.strokeStyle = "rgba(232, 184, 74, 0.85)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(w, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "10px system-ui,sans-serif";
    ctx.fillStyle = "rgba(232, 184, 74, 0.7)";
    ctx.fillText("gate", 4, threshY - 3);

    if (!bars.length) return;

    const visible = bars.slice(-cap);
    for (let j = 0; j < visible.length; j++) {
      const b = visible[j];
      const x = w - (visible.length - j) * barW;
      const norm = Math.min(b.rms / DISPLAY_MAX, 1);
      const barH = norm * (h - 12);

      let fill = "rgba(90, 100, 120, 0.5)";
      if (b.gateOpen && b.canSend) fill = "rgba(62, 207, 142, 0.85)";
      else if (b.cut || (b.speechPassed && b.canSend && !b.gateOpen)) fill = "rgba(232, 120, 74, 0.9)";
      else if (b.speechPassed) fill = "rgba(91, 141, 239, 0.55)";

      ctx.fillStyle = fill;
      ctx.fillRect(x + 1, h - barH - 2, Math.max(2, barW - 2), barH);

      if (b.cut) {
        ctx.strokeStyle = "#fca5a5";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + barW * 0.5, 2);
        ctx.lineTo(x + barW * 0.5, h - barH - 6);
        ctx.stroke();
      }
    }
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  return { start, stop, setGain: (g) => {
    gainSlider.value = String(g);
    gainVal.textContent = `${g.toFixed(2)}×`;
  } };
}
