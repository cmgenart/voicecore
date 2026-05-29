/**
 * Mic capture → local gates → PCM uplink; PCM downlink → playback.
 */

import { floatTo16BitPCM, rmsFromAnalyser, rmsFromFloat32, base64ToFloat32 } from "./util.js";

const BAND_EDGES = [20, 60, 150, 350, 700, 1400, 2800, 5500, 9500, 14000, 20000];

/**
 * @typedef {import('./config.js').VoiceCoreConfig} VoiceCoreConfig
 * @typedef {import('./echo-gate.js').EchoGate} EchoGate
 */

export class AudioPipeline {
  /**
   * @param {VoiceCoreConfig} config
   * @param {EchoGate} echoGate
   */
  constructor(config, echoGate) {
    this.config = config;
    this.echoGate = echoGate;

    /** @type {AudioContext|null} */
    this.audioCtx = null;
    /** @type {MediaStream|null} */
    this.micStream = null;
    /** @type {ScriptProcessorNode|null} */
    this.micProcessor = null;
    /** @type {AnalyserNode|null} */
    this.micAnalyser = null;
    /** @type {AnalyserNode|null} */
    this.outAnalyser = null;
    /** @type {Float32Array[]} */
    this.audioQueue = [];
    this.isPlaying = false;
    this.isModelSpeaking = false;
    this.playbackPaused = false;
    /** @type {Uint8Array|null} */
    this.fftData = null;
    this.displayVol = 0;
    this.displayBands = new Array(10).fill(0);
    this.inputSampleRate = config.sampleRate;
    this.micCaptureReady = false;
    this.micSendHangoverUntil = 0;
    this.utteranceLatchUntil = 0;
    this.noiseFloorRms = 0.008;
    /** @type {Uint8Array[]} */
    this.micPreRollChunks = [];
    this.micPreRollBytes = 0;
    this.micGateOpen = false;
    /** @type {GainNode|null} */
    this.micGainNode = null;
    /** Latest frame metrics for waveform UI */
    this.monitor = {
      rms: 0,
      threshold: 0,
      speechPassed: false,
      gateOpen: false,
      canSend: false,
      assistantActive: false,
    };

    /** @type {(pcm: Uint8Array) => void|null} */
    this.onMicPcm = null;
    /** @type {() => boolean|null} */
    this.shouldSendMic = null;
    /** @type {() => boolean|null} */
    this.shouldBypassSpeechGate = null;
    /** @type {() => void|null} */
    this.onPlaybackIdle = null;
    /** @type {((open: boolean) => void)|null} */
    this.onMicGateChange = null;
    /** @type {AudioBufferSourceNode|null} */
    this.activeSource = null;
    /** @type {Promise<void>|null} */
    this.micPreparePromise = null;
  }

  prepareMic() {
    if (this.micPreparePromise) return this.micPreparePromise;
    this.micPreparePromise = this.echoGate
      .prepareMic()
      .catch(() => {})
      .finally(() => {
        this.micPreparePromise = null;
      });
    return this.micPreparePromise;
  }

  getInputSampleRate() {
    return this.inputSampleRate;
  }

  isMicCaptureReady() {
    return this.micCaptureReady && !!this.micProcessor && this.audioCtx?.state === "running";
  }

  async startOutput() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: this.config.sampleRate });
    }
    await this.ensureRunning();
    if (!this.outAnalyser) {
      this.outAnalyser = this.audioCtx.createAnalyser();
      this.outAnalyser.fftSize = 4096;
    }
    this.echoGate.setAnalysers(this.micAnalyser, this.outAnalyser, this.audioCtx.sampleRate);
  }

  /**
   * @param {MediaStream} stream
   * @returns {Promise<boolean>}
   */
  async startCapture(stream) {
    await this.startOutput();
    if (!this.audioCtx) return false;

    this.micStream = stream;
    const ctxRate = this.audioCtx.sampleRate;
    this.inputSampleRate = this.config.allowedInputRates.includes(ctxRate)
      ? ctxRate
      : this.config.sampleRate;

    const micSource = this.audioCtx.createMediaStreamSource(this.micStream);
    this.micGainNode = this.audioCtx.createGain();
    this.applyMicGain();
    micSource.connect(this.micGainNode);

    this.micAnalyser = this.audioCtx.createAnalyser();
    this.micAnalyser.fftSize = 2048;
    this.micGainNode.connect(this.micAnalyser);
    this.echoGate.setAnalysers(this.micAnalyser, this.outAnalyser, this.audioCtx.sampleRate);

    const bufSize = this.config.processorBufferSize;
    this.micProcessor = this.audioCtx.createScriptProcessor(bufSize, 1, 1);
    this.micProcessor.onaudioprocess = (e) => this.onAudioProcess(e);
    this.micGainNode.connect(this.micProcessor);
    const silent = this.audioCtx.createGain();
    silent.gain.value = 0;
    this.micProcessor.connect(silent);
    silent.connect(this.audioCtx.destination);

    this.micCaptureReady = this.audioCtx.state === "running";
    return this.micCaptureReady;
  }

  applyMicGain() {
    if (this.micGainNode) {
      this.micGainNode.gain.value = Math.max(0.25, Math.min(4, this.config.speech.micGain ?? 1));
    }
  }

  /**
   * @param {Float32Array} channel
   */
  updateMonitorFrame(channel) {
    const rms = rmsFromFloat32(channel);
    const threshold = this.speechGateThreshold();
    const now = performance.now();
    const speechPassed =
      rms >= threshold || now < this.micSendHangoverUntil || this.shouldStreamUtterance();
    this.monitor = {
      rms,
      threshold,
      speechPassed,
      gateOpen: this.micGateOpen,
      canSend: Boolean(this.shouldSendMic?.()),
      assistantActive: this.isAssistantOutputActive(),
    };
  }

  getMonitorFrame() {
    return { ...this.monitor };
  }

  /** @param {AudioProcessingEvent} e */
  onAudioProcess(e) {
    const channel = e.inputBuffer.getChannelData(0);
    this.updateMonitorFrame(channel);

    if (!this.shouldSendMic?.()) {
      this.setMicGateOpen(false);
      this.updateMonitorFrame(channel);
      return;
    }

    const pcm = floatTo16BitPCM(channel);
    const assistantActive = this.isAssistantOutputActive();

    if (assistantActive) {
      if (!this.echoGate.shouldForwardMic(channel, true)) {
        this.setMicGateOpen(false);
        return;
      }
      // During playback, also require local speech gate so speaker bleed cannot
      // uplink or trigger tentative barge / server VAD false interrupts.
      if (!this.passesSpeechGate(channel)) {
        this.setMicGateOpen(false);
        return;
      }
      this.clearPreRoll();
      this.setMicGateOpen(true);
      this.onMicPcm?.(pcm);
      return;
    }

    if (this.shouldStreamUtterance()) {
      if (this.passesSpeechGate(channel)) this.extendUtteranceLatch();
      this.clearPreRoll();
      this.setMicGateOpen(true);
      this.onMicPcm?.(pcm);
      return;
    }

    const speechOpen = this.passesSpeechGate(channel);
    if (!speechOpen) {
      this.pushPreRoll(pcm);
      this.setMicGateOpen(false);
      return;
    }

    this.flushPreRoll();
    this.extendUtteranceLatch();
    this.setMicGateOpen(true);
    this.onMicPcm?.(pcm);
  }

  async ensureRunning() {
    if (!this.audioCtx) return false;
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
    this.micStream?.getAudioTracks().forEach((t) => {
      t.enabled = true;
    });
    return this.audioCtx.state === "running";
  }

  isAssistantOutputActive() {
    return this.isModelSpeaking || this.isPlaying;
  }

  shouldStreamUtterance() {
    return Boolean(this.shouldBypassSpeechGate?.()) || performance.now() < this.utteranceLatchUntil;
  }

  extendUtteranceLatch() {
    this.utteranceLatchUntil = performance.now() + this.config.utterance.latchMs;
  }

  passesSpeechGate(channel) {
    const micRms = rmsFromFloat32(channel);
    const now = performance.now();
    const threshold = Math.max(
      this.config.speech.minRms,
      this.noiseFloorRms * this.config.speech.noiseMargin + 0.006,
    );

    if (micRms >= threshold) {
      this.micSendHangoverUntil = now + this.config.speech.hangoverMs;
      return true;
    }

    if (now >= this.micSendHangoverUntil) {
      this.noiseFloorRms = this.noiseFloorRms * 0.985 + micRms * 0.015;
      this.noiseFloorRms = Math.min(Math.max(this.noiseFloorRms, 0.003), 0.04);
    }

    return now < this.micSendHangoverUntil;
  }

  /** Current adaptive speech gate threshold (for debug UI). */
  speechGateThreshold() {
    return Math.max(
      this.config.speech.minRms,
      this.noiseFloorRms * this.config.speech.noiseMargin + 0.006,
    );
  }

  /** @param {Uint8Array} pcm */
  pushPreRoll(pcm) {
    this.micPreRollChunks.push(pcm);
    this.micPreRollBytes += pcm.byteLength;
    const maxBytes = Math.ceil((this.inputSampleRate * 2 * this.config.speech.preRollMs) / 1000);
    while (this.micPreRollBytes > maxBytes && this.micPreRollChunks.length) {
      const dropped = this.micPreRollChunks.shift();
      if (dropped) this.micPreRollBytes -= dropped.byteLength;
    }
  }

  flushPreRoll() {
    if (!this.micPreRollChunks.length) return;
    for (const chunk of this.micPreRollChunks) this.onMicPcm?.(chunk);
    this.clearPreRoll();
  }

  clearPreRoll() {
    this.micPreRollChunks = [];
    this.micPreRollBytes = 0;
  }

  /** @param {boolean} open */
  setMicGateOpen(open) {
    if (this.micGateOpen === open) return;
    this.micGateOpen = open;
    this.monitor.gateOpen = open;
    this.onMicGateChange?.(open);
  }

  resetMicGate() {
    this.micSendHangoverUntil = 0;
    this.utteranceLatchUntil = 0;
    this.clearPreRoll();
    this.setMicGateOpen(false);
  }

  /**
   * @param {number} dt seconds
   */
  decayDisplayLevels(dt) {
    const step = this.config.playback.volDecayPerSec * dt;
    this.displayVol = Math.max(0, this.displayVol - step);
    this.displayBands = this.displayBands.map((v) => Math.max(0, v - step));
    this.echoGate.setOutputLevel(this.displayVol);
  }

  /** @param {number} vol @param {number[]} bands */
  pushDisplayLevels(vol, bands) {
    this.displayVol = Math.max(this.displayVol, vol);
    for (let i = 0; i < 10; i++) {
      this.displayBands[i] = Math.max(this.displayBands[i], bands[i] ?? 0);
    }
    this.echoGate.setOutputLevel(this.displayVol);
  }

  /** @param {string} base64Audio */
  enqueueDelta(base64Audio) {
    if (!this.audioCtx || !base64Audio || this.playbackPaused) return;
    const float32 = base64ToFloat32(base64Audio);
    this.audioQueue.push(float32);
    if (!this.isPlaying) this.playNextChunk();
  }

  playNextChunk() {
    if (this.playbackPaused || !this.audioQueue.length || !this.audioCtx || !this.outAnalyser) {
      const wasPlaying = this.isPlaying;
      this.isPlaying = false;
      if (wasPlaying) this.onPlaybackIdle?.();
      return;
    }
    this.isPlaying = true;
    const float32 = this.audioQueue.shift();
    const buffer = this.audioCtx.createBuffer(1, float32.length, this.config.sampleRate);
    buffer.copyToChannel(float32, 0);
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outAnalyser);
    source.connect(this.audioCtx.destination);
    this.activeSource = source;
    source.onended = () => {
      this.activeSource = null;
      this.playNextChunk();
    };
    source.start();
  }

  stopPlayback() {
    this.audioQueue = [];
    this.playbackPaused = false;
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
      } catch {
        /* already stopped */
      }
      this.activeSource = null;
    }
    this.isPlaying = false;
    this.isModelSpeaking = false;
  }

  /** Pause playback for false-barge-in recovery without clearing queue. */
  pausePlayback() {
    this.playbackPaused = true;
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
      } catch {
        /* ignore */
      }
      this.activeSource = null;
    }
    this.isPlaying = false;
  }

  resumePlayback() {
    this.playbackPaused = false;
    if (!this.isPlaying && this.audioQueue.length) this.playNextChunk();
  }

  hasQueuedAudio() {
    return this.audioQueue.length > 0 || this.isPlaying;
  }

  teardown() {
    try {
      this.micProcessor?.disconnect();
    } catch {
      /* ignore */
    }
    this.micProcessor = null;
    this.micGainNode = null;
    this.micAnalyser = null;
    this.micStream = null;
    this.outAnalyser = null;
    this.stopPlayback();
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch {
        /* ignore */
      }
    }
    this.audioCtx = null;
    this.micCaptureReady = false;
    this.displayVol = 0;
    this.displayBands = new Array(10).fill(0);
    this.resetMicGate();
  }

  /**
   * @param {string} phaseState
   */
  sampleLevels(phaseState) {
    let mic = 0;
    if (phaseState === "listening" && this.micAnalyser) {
      mic = rmsFromAnalyser(this.micAnalyser);
    }

    let rawVol = 0;
    let rawBands = new Array(10).fill(0);
    if ((phaseState === "speaking" || this.isPlaying) && this.outAnalyser) {
      const o = bandsFromAnalyserRaw(this.outAnalyser, this);
      rawBands = o.bands;
      rawVol = o.overall;
    }
    this.pushDisplayLevels(rawVol, rawBands);

    return { mic, vol: this.displayVol, bands: [...this.displayBands] };
  }
}

/**
 * @param {AnalyserNode} analyser
 * @param {AudioPipeline} pipe
 */
function bandsFromAnalyserRaw(analyser, pipe) {
  if (!pipe.fftData) pipe.fftData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(pipe.fftData);
  const sr = pipe.audioCtx?.sampleRate ?? pipe.config.sampleRate;
  const out = [];
  for (let b = 0; b < 10; b++) {
    const fLo = BAND_EDGES[b];
    const fHi = BAND_EDGES[b + 1];
    const binLo = Math.max(0, Math.floor((fLo * analyser.fftSize) / sr));
    const binHi = Math.min(pipe.fftData.length - 1, Math.floor((fHi * analyser.fftSize) / sr));
    let sum = 0;
    for (let i = binLo; i <= binHi; i++) sum += pipe.fftData[i];
    const e = binHi > binLo ? sum / (binHi - binLo + 1) / 255 : 0;
    out.push(e);
  }
  const overall = out.reduce((a, x) => a + x, 0) / 10;
  return { bands: out, overall };
}
