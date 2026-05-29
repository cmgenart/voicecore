/**
 * VoiceCore — focused real-time voice I/O for xAI Realtime + Electron.
 * Speech only: no tools, memory, or agency.
 */

import { mergeConfig, PARAM_FPS } from "./config.js";
import { StateMachine, STATE } from "./state-machine.js";
import { EchoGate } from "./echo-gate.js";
import { AudioPipeline } from "./audio-pipeline.js";
import { RealtimeTransport } from "./realtime-transport.js";

export { STATE, StateMachine } from "./state-machine.js";
export { mergeConfig, defaultConfig, SAMPLE_RATE, MODEL } from "./config.js";
export { AudioPipeline } from "./audio-pipeline.js";
export { EchoGate } from "./echo-gate.js";
export { RealtimeTransport } from "./realtime-transport.js";

/**
 * @typedef {import('./config.js').VoiceCoreConfig} VoiceCoreConfig
 */

export class VoiceCore extends EventTarget {
  /**
   * @param {{ config?: Partial<VoiceCoreConfig> }} [options]
   */
  constructor(options = {}) {
    super();
    this.config = mergeConfig(options.config);
    this.stateMachine = new StateMachine();
    this.stateMachine.addEventListener("state-change", (e) => {
      this.emitDomain("state-change", e.detail);
    });
    this.echoGate = new EchoGate(this.config);
    this.audio = new AudioPipeline(this.config, this.echoGate);
    /** @type {RealtimeTransport|null} */
    this.transport = null;
    this.running = false;
    this.serverUserSpeaking = false;
    this.aiStarted = false;
    this.dropActiveResponse = false;
    this.tentativeBarge = false;
    this.tentativeBargeSince = 0;
    this.localBargeFrames = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.falseBargeTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.thinkingTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.levelTimer = null;
    this.aiLineBuf = "";
    this.lastLevelTick = 0;
    this.holdDeferred = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.responseWatchdogTimer = null;
  }

  get isActive() {
    return this.running;
  }

  getHoldDeferred() {
    return this.holdDeferred;
  }

  /**
   * Defer turn-end while user holds (thinking pause). Suppresses mic uplink.
   * @param {boolean} deferred
   */
  setHoldDeferred(deferred) {
    if (this.holdDeferred === deferred) return;
    this.holdDeferred = deferred;
    this.emitDomain("hold-change", { active: deferred });
  }

  /** @returns {VoiceCoreConfig} */
  getConfig() {
    return structuredClone(this.config);
  }

  /**
   * Merge tuning overrides; call applySessionVad() to push VAD to xAI when connected.
   * @param {Partial<VoiceCoreConfig>} partial
   */
  setConfig(partial) {
    this.config = mergeConfig(partial, this.config);
    this.echoGate.config = this.config;
    this.audio.config = this.config;
    this.audio.applyMicGain();
    this.transport?.setConfig(this.config);
  }

  /** Push current turn_detection to xAI (uses live assistant-speaking state). */
  applySessionVad() {
    if (!this.transport?.isOpen) return false;
    const assistantSpeaking =
      this.stateMachine.getState() === STATE.SPEAKING ||
      this.audio.isModelSpeaking ||
      this.audio.isPlaying;
    this.transport.pushTurnDetection(assistantSpeaking, { force: true });
    return true;
  }

  /**
   * Mic / gate debug info for tuning UI.
   */
  getDebugInfo() {
    const m = this.audio.getMonitorFrame();
    return {
      micGateOpen: this.audio.micGateOpen,
      speechGateThreshold: this.audio.speechGateThreshold(),
      noiseFloorRms: this.audio.noiseFloorRms,
      holdDeferred: this.holdDeferred,
      echoMode: this.echoGate.getMode(),
      micRms: m.rms,
      speechPassed: m.speechPassed,
      micGain: this.config.speech.micGain,
    };
  }

  /** Live mic frame for waveform (local speech gate, not server VAD). */
  getMicMonitorFrame() {
    return this.audio.getMonitorFrame();
  }

  getState() {
    return this.stateMachine.getState();
  }

  getLevels() {
    return this.audio.sampleLevels(this.stateMachine.getState());
  }

  getEchoMode() {
    return this.echoGate.getMode();
  }

  /** Echo path + Krisp fallback details for tuning UI. */
  getEchoInfo() {
    return {
      mode: this.echoGate.getMode(),
      preferKrisp: this.config.echo.preferKrisp,
      krispError: this.echoGate.krispError,
    };
  }

  isMicGateOpen() {
    return this.audio.micGateOpen;
  }

  prepareMic() {
    return this.audio.prepareMic();
  }

  /**
   * @param {{ apiKey: string, voice?: string, instructions?: string, requestIntro?: boolean }} opts
   */
  async connect(opts) {
    if (this.running) await this.disconnect();

    this.running = true;
    this.stateMachine.transition(STATE.CONNECTING, "connect");

    try {
      const stream = await this.echoGate.init();
      await this.audio.startCapture(stream);
      this.wireMicCapture();

      const voice = (opts.voice ?? this.config.session.defaultVoice).toLowerCase();
      const instructions = opts.instructions ?? this.config.session.defaultInstructions;
      const requestIntro = opts.requestIntro ?? this.config.session.requestIntro;

      this.transport = new RealtimeTransport(this.config, {
        onMessage: (msg) => this.handleServerMessage(msg),
        onClose: () => this.disconnect(true),
        onError: (err) => this.emitError(err.message, err),
      });

      await this.transport.connect({
        apiKey: opts.apiKey,
        voice,
        instructions,
        inputSampleRate: this.audio.getInputSampleRate(),
      });

      this.audio.onPlaybackIdle = () => this.handlePlaybackIdle();

      this.stateMachine.transition(STATE.LISTENING, "session_ready");
      this.startLevelLoop();

      if (requestIntro) {
        this.transport.requestResponse();
      }
    } catch (err) {
      this.running = false;
      this.stateMachine.reset();
      const message = err instanceof Error ? err.message : String(err);
      this.emitError(message, err instanceof Error ? err : undefined);
      await this.teardownResources();
      throw err;
    }
  }

  wireMicCapture() {
    this.audio.shouldBypassSpeechGate = () => this.serverUserSpeaking;

    this.audio.onMicPcm = (pcm) => {
      if (!this.running || !this.transport?.isOpen) return;
      this.transport.appendAudio(pcm);
      this.checkLocalBargeCandidate();
    };

    this.audio.shouldSendMic = () => {
      if (!this.running || !this.audio.isMicCaptureReady()) return false;
      if (!this.transport?.isOpen) return false;
      if (this.holdDeferred) return false;
      return this.stateMachine.isMicHot();
    };
  }

  /** Tentative local barge during SPEAKING when echo gate passes sustained frames. */
  checkLocalBargeCandidate() {
    if (this.stateMachine.getState() !== STATE.SPEAKING) {
      this.localBargeFrames = 0;
      return;
    }
    if (!this.audio.isAssistantOutputActive()) return;

    const frameMs = this.config.barge.localFrameMs;
    this.localBargeFrames += 1;
    const needed = Math.max(1, Math.ceil(this.config.barge.localConfirmMs / frameMs));

    if (this.localBargeFrames < needed) return;

    if (!this.tentativeBarge) {
      this.tentativeBarge = true;
      this.tentativeBargeSince = performance.now();
      // Pause only — do not cancel the server response until speech_started confirms.
      this.audio.pausePlayback();
      this.scheduleFalseBargeRecovery();
    }
  }

  scheduleFalseBargeRecovery() {
    if (this.falseBargeTimer) clearTimeout(this.falseBargeTimer);
    const waitMs = Math.max(
      this.config.barge.falseRecoveryMs,
      this.config.barge.serverConfirmMs,
    );
    this.falseBargeTimer = setTimeout(() => {
      this.falseBargeTimer = null;
      if (!this.tentativeBarge || this.serverUserSpeaking) return;
      this.abortTentativeBarge();
    }, waitMs);
  }

  abortTentativeBarge() {
    if (!this.tentativeBarge) return;
    this.tentativeBarge = false;
    this.localBargeFrames = 0;
    this.emitDomain("barge-in-aborted", {});
    if (this.audio.hasQueuedAudio()) {
      this.audio.resumePlayback();
      if (this.stateMachine.getState() !== STATE.SPEAKING) {
        this.stateMachine.transition(STATE.SPEAKING, "false_barge_recovery");
      }
    }
  }

  clearTentativeBarge() {
    this.tentativeBarge = false;
    this.localBargeFrames = 0;
    if (this.falseBargeTimer) {
      clearTimeout(this.falseBargeTimer);
      this.falseBargeTimer = null;
    }
  }

  /**
   * @param {boolean} [fromWs]
   */
  async disconnect(fromWs = false) {
    if (!this.running && this.stateMachine.getState() === STATE.IDLE) return;
    this.running = false;
    this.stopLevelLoop();
    this.clearTentativeBarge();
    this.clearResponseWatchdog();
    this.holdDeferred = false;
    this.serverUserSpeaking = false;
    this.aiStarted = false;

    if (this.transport && !fromWs) this.transport.close();
    this.transport = null;

    await this.teardownResources();
    this.stateMachine.transition(STATE.IDLE, fromWs ? "ws_close" : "disconnect");
  }

  async teardownResources() {
    this.audio.onPlaybackIdle = null;
    this.audio.teardown();
    this.echoGate.destroy();
  }

  /**
   * @param {string} text
   */
  sendText(text) {
    if (!this.transport?.isOpen) return;
    this.transport.sendText(text);
    this.enterThinking("text_send");
  }

  /**
   * @param {object} msg
   */
  handleServerMessage(msg) {
    if (msg.type === "error") {
      const errText = msg.error?.message || JSON.stringify(msg.error);
      if (typeof errText === "string" && /no active response/i.test(errText)) return;
      this.emitError(errText || "Server error");
      return;
    }

    if (isAudioDelta(msg)) {
      if (this.dropActiveResponse) return;
      if (!this.aiStarted) {
        this.aiStarted = true;
        this.emitDomain("ai-start", {});
        this.stateMachine.transition(STATE.SPEAKING, "ai_audio");
      }
      this.audio.isModelSpeaking = true;
      this.syncVad();
      this.audio.enqueueDelta(msg.delta);
      return;
    }

    if (isAiTranscriptDelta(msg)) {
      if (this.dropActiveResponse) return;
      this.aiLineBuf += msg.delta || "";
      this.emitDomain("transcript", {
        role: "assistant",
        text: this.aiLineBuf,
        final: false,
      });
      return;
    }

    if (isAiTranscriptDone(msg)) {
      if (this.dropActiveResponse) return;
      const text = msg.transcript || this.aiLineBuf;
      this.aiLineBuf = text;
      this.emitDomain("transcript", { role: "assistant", text, final: true });
      return;
    }

    if (msg.type === "input_audio_buffer.speech_started") {
      this.serverUserSpeaking = true;
      this.audio.extendUtteranceLatch();
      this.clearTentativeBarge();

      const wasSpeaking = this.stateMachine.isAssistantActive() || this.audio.isAssistantOutputActive();
      if (wasSpeaking) {
        this.performBargeIn("server");
      } else if (this.transport?.serverResponseActive) {
        this.dropActiveResponse = true;
        this.transport.cancelResponse();
      }

      this.emitDomain("user-speech-start", { source: "server" });
      if (this.stateMachine.getState() !== STATE.BARGE_IN) {
        this.stateMachine.transition(STATE.LISTENING, "user_speech");
      }
      this.exitThinking();
      return;
    }

    if (msg.type === "input_audio_buffer.speech_stopped") {
      this.serverUserSpeaking = false;
      this.audio.extendUtteranceLatch();
      if (this.holdDeferred) {
        this.transport?.cancelResponse();
        return;
      }
      this.emitDomain("user-speech-end", {});
      this.enterThinking("speech_stopped");
      this.scheduleResponseWatchdog();
      return;
    }

    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      if (msg.transcript) {
        this.emitDomain("transcript", {
          role: "user",
          text: msg.transcript,
          final: true,
        });
      }
      return;
    }

    if (msg.type === "response.created") {
      this.clearResponseWatchdog();
      this.dropActiveResponse = false;
      this.transport?.setServerResponseActive(true);
      return;
    }

    if (msg.type === "response.done") {
      this.transport?.setServerResponseActive(false);
      this.dropActiveResponse = false;
      this.maybeAiEnd();
      return;
    }
  }

  /**
   * @param {"server"|"local"} source
   */
  performBargeIn(source) {
    this.clearTentativeBarge();
    const partialTranscript = this.aiLineBuf.trim();
    this.dropActiveResponse = true;
    this.audio.stopPlayback();
    this.transport?.forceCancelResponse();
    this.aiStarted = false;
    this.aiLineBuf = "";
    this.audio.isModelSpeaking = false;
    this.syncVad();
    this.stateMachine.transition(STATE.BARGE_IN, "barge_in");
    this.emitDomain("barge-in", { source, partialTranscript });
    this.stateMachine.transition(STATE.LISTENING, "barge_done");
  }

  scheduleResponseWatchdog() {
    this.clearResponseWatchdog();
    this.responseWatchdogTimer = setTimeout(() => {
      this.responseWatchdogTimer = null;
      if (!this.running || !this.transport?.isOpen) return;
      if (this.transport.serverResponseActive) return;
      if (this.stateMachine.getState() !== STATE.THINKING) return;
      if (this.serverUserSpeaking) return;
      this.transport.requestResponse();
    }, 4500);
  }

  clearResponseWatchdog() {
    if (this.responseWatchdogTimer) {
      clearTimeout(this.responseWatchdogTimer);
      this.responseWatchdogTimer = null;
    }
  }

  enterThinking(reason) {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = null;
      if (!this.running) return;
      if (this.stateMachine.getState() === STATE.SPEAKING) return;
      this.stateMachine.transition(STATE.THINKING, reason);
    }, this.config.thinking.minMs);
  }

  exitThinking() {
    if (this.thinkingTimer) {
      clearTimeout(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    if (this.stateMachine.getState() === STATE.THINKING) {
      this.stateMachine.transition(STATE.LISTENING, "user_speech");
    }
  }

  handlePlaybackIdle() {
    this.audio.isModelSpeaking = false;
    this.syncVad();
    this.maybeAiEnd();
  }

  maybeAiEnd() {
    if (this.audio.isAssistantOutputActive()) return;
    if (this.transport?.serverResponseActive) return;
    if (!this.aiStarted) return;
    this.aiStarted = false;
    this.emitDomain("ai-end", {});
    this.exitThinking();
    if (this.stateMachine.getState() !== STATE.LISTENING) {
      this.stateMachine.transition(STATE.LISTENING, "ai_end");
    }
  }

  syncVad() {
    const speaking =
      this.stateMachine.getState() === STATE.SPEAKING ||
      this.audio.isModelSpeaking ||
      this.audio.isPlaying;
    this.transport?.syncVad(speaking);
  }

  startLevelLoop() {
    this.stopLevelLoop();
    this.lastLevelTick = performance.now();
    this.levelTimer = setInterval(() => {
      const now = performance.now();
      const dt = (now - this.lastLevelTick) / 1000;
      this.lastLevelTick = now;
      this.audio.decayDisplayLevels(dt);
      this.syncVad();
    }, 1000 / PARAM_FPS);
  }

  stopLevelLoop() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
  }

  /**
   * @param {string} type
   * @param {object} detail
   */
  emitDomain(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * @param {string} message
   * @param {Error} [cause]
   */
  emitError(message, cause) {
    this.emitDomain("error", { message, cause });
  }
}

function isAudioDelta(msg) {
  return msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta";
}

function isAiTranscriptDelta(msg) {
  return (
    msg.type === "response.output_audio_transcript.delta" ||
    msg.type === "response.audio_transcript.delta"
  );
}

function isAiTranscriptDone(msg) {
  return (
    msg.type === "response.output_audio_transcript.done" ||
    msg.type === "response.audio_transcript.done"
  );
}
