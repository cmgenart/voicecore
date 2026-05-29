/**
 * Slim xAI Realtime WebSocket transport — audio and transcripts only, no tools.
 */

import { MODEL, vadSettings } from "./config.js";
import { arrayBufferToBase64 } from "./util.js";

/**
 * @typedef {import('./config.js').VoiceCoreConfig} VoiceCoreConfig
 */

export class RealtimeTransport {
  /**
   * @param {VoiceCoreConfig} config
   * @param {{ onMessage: (msg: object) => void, onOpen?: () => void, onClose?: () => void, onError?: (err: Error) => void }} handlers
   */
  constructor(config, handlers) {
    this.config = config;
    this.handlers = handlers;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.apiKey = "";
    this.sessionConfigured = false;
    this.serverResponseActive = false;
    this.lastVadSpeaking = false;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * @param {{ apiKey: string, voice: string, instructions: string, inputSampleRate: number }} opts
   */
  async connect(opts) {
    this.apiKey = opts.apiKey;
    const secret = await this.fetchClientSecret();
    const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(MODEL)}`;
    this.ws = new WebSocket(url, [`xai-client-secret.${secret}`]);

    await new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error("WebSocket failed"));
      this.ws.onopen = () => resolve(undefined);
      this.ws.onerror = () => reject(new Error("WebSocket error"));
    });

    this.ws.onmessage = (ev) => {
      try {
        const raw = typeof ev.data === "string" ? ev.data : "";
        if (raw) this.handlers.onMessage(JSON.parse(raw));
      } catch (err) {
        console.warn("[VoiceCore] message parse", err);
      }
    };
    this.ws.onclose = () => this.handlers.onClose?.();
    this.ws.onerror = () => this.handlers.onError?.(new Error("WebSocket error"));

    this.sendSessionUpdate({
      instructions: opts.instructions,
      voice: opts.voice,
      inputSampleRate: opts.inputSampleRate,
    });

    this.sessionConfigured = true;
    this.handlers.onOpen?.();
  }

  async fetchClientSecret() {
    const res = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        expires_after: { seconds: this.config.session.secretExpiresSec },
        model: MODEL,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`client_secrets ${res.status}: ${t.slice(0, 120)}`);
    }
    const data = await res.json();
    if (!data.value) throw new Error("No client secret");
    return data.value;
  }

  /**
   * @param {{ instructions: string, voice: string, inputSampleRate: number }} opts
   */
  sendSessionUpdate(opts) {
    this.send({
      type: "session.update",
      session: {
        instructions: opts.instructions,
        voice: opts.voice,
        turn_detection: vadSettings(this.config, false),
        audio: {
          input: { format: { type: "audio/pcm", rate: opts.inputSampleRate } },
          output: { format: { type: "audio/pcm", rate: this.config.sampleRate } },
        },
      },
    });
  }

  /** @param {VoiceCoreConfig} config */
  setConfig(config) {
    this.config = config;
  }

  /** @param {boolean} assistantSpeaking */
  syncVad(assistantSpeaking) {
    if (!this.isOpen || !this.sessionConfigured) return;
    if (assistantSpeaking === this.lastVadSpeaking) return;
    this.pushTurnDetection(assistantSpeaking);
  }

  /**
   * Push turn_detection to server (optionally force even if state unchanged).
   * @param {boolean} assistantSpeaking
   * @param {{ force?: boolean }} [opts]
   */
  pushTurnDetection(assistantSpeaking, opts = {}) {
    if (!this.isOpen || !this.sessionConfigured) return;
    if (!opts.force && assistantSpeaking === this.lastVadSpeaking) return;
    this.lastVadSpeaking = assistantSpeaking;
    this.send({
      type: "session.update",
      session: {
        turn_detection: vadSettings(this.config, assistantSpeaking),
      },
    });
  }

  /** @param {number} inputSampleRate */
  updateInputRate(inputSampleRate) {
    if (!this.isOpen) return;
    this.send({
      type: "session.update",
      session: {
        audio: {
          input: { format: { type: "audio/pcm", rate: inputSampleRate } },
        },
      },
    });
  }

  /** @param {Uint8Array} pcm */
  appendAudio(pcm) {
    this.send({
      type: "input_audio_buffer.append",
      audio: arrayBufferToBase64(pcm),
    });
  }

  requestResponse() {
    this.send({ type: "response.create" });
  }

  /** @param {string} text */
  sendText(text) {
    const t = text.trim();
    if (!t) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: t }],
      },
    });
    this.send({ type: "response.create" });
  }

  cancelResponse() {
    const hadActive = this.serverResponseActive;
    this.serverResponseActive = false;
    if (hadActive) this.send({ type: "response.cancel" });
    return hadActive;
  }

  /** Cancel even if response.created was missed (e.g. early audio deltas). */
  forceCancelResponse() {
    this.serverResponseActive = false;
    this.send({ type: "response.cancel" });
  }

  setServerResponseActive(active) {
    this.serverResponseActive = active;
  }

  /** @param {object} payload */
  send(payload) {
    if (!this.isOpen) return;
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
    this.sessionConfigured = false;
    this.serverResponseActive = false;
    this.lastVadSpeaking = false;
  }
}
