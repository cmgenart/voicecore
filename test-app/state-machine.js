/**
 * Voice-only conversation state machine.
 */

export const STATE = {
  IDLE: "idle",
  CONNECTING: "connecting",
  LISTENING: "listening",
  SPEAKING: "speaking",
  THINKING: "thinking",
  BARGE_IN: "barge_in",
};

/** States where mic uplink is allowed. */
export const MIC_HOT_STATES = new Set([
  STATE.LISTENING,
  STATE.SPEAKING,
  STATE.THINKING,
  STATE.BARGE_IN,
]);

/**
 * @typedef {Object} TransitionDetail
 * @property {string} from
 * @property {string} to
 * @property {string} reason
 */

export class StateMachine extends EventTarget {
  constructor() {
    super();
    /** @type {string} */
    this.state = STATE.IDLE;
  }

  getState() {
    return this.state;
  }

  isMicHot() {
    return MIC_HOT_STATES.has(this.state);
  }

  isAssistantActive() {
    return this.state === STATE.SPEAKING || this.state === STATE.BARGE_IN;
  }

  /**
   * @param {string} next
   * @param {string} [reason]
   * @returns {boolean} true if state changed
   */
  transition(next, reason = "") {
    if (this.state === next) return false;
    const from = this.state;
    this.state = next;
    const detail = /** @type {TransitionDetail} */ ({ from, to: next, reason });
    this.dispatchEvent(new CustomEvent("state-change", { detail }));
    return true;
  }

  reset() {
    this.transition(STATE.IDLE, "reset");
  }
}
