# VoiceCore — Next Phase Roadmap

**Version:** 0.2 (planning)  
**Date:** May 2026  
**Status:** Ready for design review and implementation  
**Baseline:** v0.1 preserved on GitHub (`main`)

> **Compatibility note:** VoiceCore v0.2 is designed for clean integration with SentienceTool. VoiceCore owns speech I/O only; SentienceTool owns tools, memory, stitching, and agency. See [SentienceTool compatibility](#sentiencetool-compatibility-reviewed) below.

---

## Strategy

VoiceCore development follows a **two-stage** path:

| Stage | Focus | Exit criteria |
|-------|--------|---------------|
| **A — Electron app** | Build and validate v0.2 features in the standalone test harness | All v0.2 features work reliably in Electron; manual regression checklist passes |
| **B — Module** | Extract publishable package; wire SentienceTool | `src/` is the single source of truth; SentienceTool runs on VoiceCore behind a flag |

**Principle:** The Electron test app is the **fast loop** for acoustics, cost management, and API shape. Module extraction happens only after behaviour is stable — not in parallel with core feature work.

```
GitHub v0.1 (frozen reference)
        │
        ▼
  test-app/  ──►  v0.2 features  ──►  regression + tuning  ──►  src/ module  ──►  SentienceTool
  (Electron)        (Stage A)              (Stage A exit)         (Stage B)          (Stage B exit)
```

---

## What VoiceCore is (and is not)

VoiceCore is a **clean, minimal real-time voice I/O engine** for Electron and browser renderers.

### Owns

- Microphone capture + echo cancellation (Krisp optional → AEC3 → software gate)
- Natural barge-in (server + local tentative + false-barge recovery)
- xAI Realtime WebSocket transport (PCM16 @ 24 kHz)
- Smart cost-saving session management (auto-suspend + fast resume)
- Transparent event system mirroring xAI Realtime API style
- Injectable tuning panel (`createTuningPanel()`)

### Never owns

| Concern | Owner |
|---------|--------|
| Tool calling / function routing | SentienceTool |
| Conversation stitching / turn management | SentienceTool |
| Memory, organizer, session persistence | SentienceTool |
| Art param bridge (`listen`, `speak`, `vol`) | Consumer maps VoiceCore events |
| Agency, task logic, intro buffer | SentienceTool |

---

## SentienceTool compatibility (reviewed)

**Verdict:** Excellent alignment. No conceptual conflicts.

VoiceCore stays speech-only; SentienceTool owns all intelligence. Required VoiceCore changes for clear domain boundaries:

| Requirement | Status in v0.1 | v0.2 action |
|-------------|----------------|-------------|
| Never attempt conversation stitching, turn management, or tool routing | ✅ Already correct | Document and enforce in API review |
| Passthrough for complex server messages (`tool-call` / raw `message` events) | ❌ Not implemented | Add transparent forward; SentienceTool handles Grok tool calls |
| `transcript` events include `itemId` when available | ❌ Not implemented | Extract from server payloads; enable SentienceTool smart stitching |
| Sleep/suspend + `resetIdleTimer()` | ❌ Not implemented | New `SessionManager` |
| Tuning panel as injectable HTML element | ⚠️ Partial — lives in `test-ui/`, not on `VoiceCore` | Move to `createTuningPanel()` on class |
| Krisp as optional peer dependency | ✅ Dynamic import + fallback | Keep; document in module `package.json` |
| Barge-in, echo gate, local gates | ✅ Implemented | No changes needed |

---

## v0.2 specification

### Public API

```js
import { VoiceCore } from "voicecore";

const voice = new VoiceCore({
  idleTimeoutMs: 45000,
  autoSuspend: true,
  preRollMs: 400,
  suspendWarningMsBefore: 5000, // default when idleTimeoutMs >= 30000
});
```

**Constructor options:** Accept both top-level keys (e.g. `idleTimeoutMs`) and nested `config` — merge them into a single effective config.

| Option | Description |
|--------|-------------|
| `suspendWarningMsBefore` | Milliseconds before entering the `SUSPENDED` state to emit the `sleep-warning` event. Default is `5000` when `idleTimeoutMs >= 30000`. |

#### Methods

| Method | Description |
|--------|-------------|
| `connect(options)` | Opens session. See [connect options](#connect-options) below |
| `disconnect()` | Fully closes everything |
| `setConfig(partial)` | Live update of any config value (including `idleTimeoutMs`, `suspendWarningMsBefore`) |
| `getConfig()` | Returns current config |
| `resetIdleTimer(ms?)` | Resets or extends the idle timer |
| `createTuningPanel()` | Returns an `HTMLElement` (Simple + Advanced tabs) |

#### Retained v0.1 methods

```js
voice.prepareMic()
voice.sendText(text)
voice.setHoldDeferred(boolean)
voice.applySessionVad()
voice.getDebugInfo()
voice.getMicMonitorFrame()
voice.getLevels()
voice.getEchoInfo()
```

#### Connect options

```js
await voice.connect({
  apiKey,
  voice: "eve",
  instructions: "...",
  requestIntro: true,
  sessionExtensions: {
    tools: buildSessionToolDefinitions(record),
  },
});
```

VoiceCore forwards `sessionExtensions` (e.g. `tools`) in `session.update` but **never executes** them. Tool handling stays in SentienceTool.

#### Tuning UI

- VoiceCore ships a ready-to-mount HTML panel via `createTuningPanel()`.
- SentienceTool (or the test app) decides where and how to mount it.
- Two modes: **Simple** (clean labels + live timers) and **Advanced** (frequency graphs, raw gate values).
- All changes apply live via `setConfig()`.

### Events (`EventTarget`)

#### Core

| Event | `detail` |
|-------|----------|
| `state-change` | `{ from, to, reason }` |
| `error` | `{ message, cause? }` |

#### User speech

| Event | `detail` |
|-------|----------|
| `user-speech-start` | `{ source: "server" \| "local", itemId? }` |
| `user-speech-end` | `{}` |
| `transcript` | `{ role: "user", text, final: boolean, itemId? }` — live deltas. User transcripts **always** include `role: "user"`. |

#### Assistant

| Event | `detail` |
|-------|----------|
| `ai-start` | `{}` |
| `ai-end` | `{}` |
| `transcript` | `{ role: "assistant", text, final: boolean }` |
| `tool-call` / `message` | Raw passthrough from server (transparent) |

#### Barge-in

| Event | `detail` |
|-------|----------|
| `barge-in` | `{ source }` |
| `barge-in-aborted` | `{}` |

#### Connection / cost

| Event | `detail` |
|-------|----------|
| `sleep-warning` | `{ msRemaining }` — emitted `suspendWarningMsBefore` ms before entering `SUSPENDED` |
| `sleep` | `{ reason: "idle" }` — enters `SUSPENDED`; WebSocket closed, mic pipeline stays warm |
| `wake` | `{ reason: "local_speech" \| "manual" \| "connect" }` — reconnect initiated |

#### Monitoring

| Event | `detail` |
|-------|----------|
| `mic-level` | `{ rms, peak, speechGateOpen }` |
| `config-change` | Full updated config object |

Existing v0.1 events retained: `hold-change`.

### Connection lifecycle & cost management

```
connect()
  │
  ├─► Session fully awake for idleTimeoutMs (default 45 s)
  │
  ├─► Activity resets timer: user speech, AI speech, sendText, resetIdleTimer()
  │
  ├─► sleep-warning at suspendWarningMsBefore (default 5 s before SUSPENDED)
  │
  └─► idle timeout → SUSPENDED (WebSocket closed, mic + pre-roll buffer stay active)
         │
         └─► Local speech detected → wake → instant reconnect + flush pre-roll
```

- `idleTimeoutMs` and `suspendWarningMsBefore` are live-configurable via `setConfig()`.
- Client can call `resetIdleTimer(ms?)` to extend or cancel pending suspend.
- `autoSuspend: false` keeps legacy always-on behaviour for debugging.

### Audio pipeline & barge-in

Unchanged from v0.1 (validated in test app):

1. Krisp (optional via dynamic import of `@livekit/krisp-noise-filter` + `livekit-client`)
2. Browser AEC3
3. Software echo gate (RMS + frequency ratio)
4. Stricter VAD + local gate while AI is speaking
5. Frequency-based speech detection to reduce false barges from noise

See [test-app/docs/design.md](../test-app/docs/design.md) for barge-in state machine, false-barge recovery, and VAD sync details.

### Internal architecture (target)

```
VoiceCore
├── StateMachine
├── RealtimeTransport
├── AudioPipeline
├── EchoGate
├── SessionManager      ← new in v0.2
├── TuningSystem        ← new in v0.2 (wraps tuning-spec + panel factory)
└── EventBus            ← implicit via EventTarget
```

Target files (Stage B module layout; developed in `test-app/` during Stage A):

| File | Responsibility |
|------|----------------|
| `index.js` | `VoiceCore` orchestrator |
| `state-machine.js` | States and transitions (+ `SUSPENDED` state) |
| `realtime-transport.js` | xAI WebSocket; passthrough hook for unhandled messages |
| `audio-pipeline.js` | Capture, gates, playback, levels |
| `echo-gate.js` | Krisp + AEC + software gate |
| `session-manager.js` | Idle timer, sleep/wake, pre-roll on resume |
| `tuning.js` | `createTuningPanel()`, specs, presets |
| `config.js` | Defaults including `idleTimeoutMs`, `autoSuspend`, `suspendWarningMsBefore` |

---

## Gap analysis: v0.1 → v0.2

Current implementation lives in `test-app/` (flat layout). `src/` is empty.

| v0.2 feature | v0.1 state | Work required |
|--------------|------------|---------------|
| Suspend / wake (`SUSPENDED`) | Not implemented in v0.1 | `SessionManager`; new state; keep mic hot while WS closed |
| `resetIdleTimer()` | Not implemented in v0.1 | Wire to SessionManager; expose on VoiceCore |
| `sleep-warning` event + `suspendWarningMsBefore` | Not implemented in v0.1 | Emit warning before entering `SUSPENDED` |
| `itemId` on transcripts | Not implemented in v0.1 | Parse from `conversation.item.*` server payloads |
| `tool-call` / `message` passthrough | Not implemented in v0.1 | Forward unhandled inbound messages as events |
| `createTuningPanel()` on VoiceCore | Partial in v0.1 — panel in `test-ui/` | Extract to `tuning.js`; mount via VoiceCore API |
| Simple vs Advanced tuning tabs | Not implemented in v0.1 | Split UI; Advanced shows graphs + raw values |
| `config-change` event | Not implemented in v0.1 | Emit after merge |
| `mic-level` event | Not implemented in v0.1 | Emit on interval (or reuse level loop) |
| Constructor top-level + nested config | Partial in v0.1 — nested only | Merge top-level and nested `config` into single effective config |

**No changes needed:** barge-in logic, echo gate, local gates, Krisp optional path, hold-deferred, VAD sync.

---

## Stage A — Electron app (implement v0.2)

**Location:** `test-app/` remains source of truth until Stage B exit.

### A1 — SessionManager & cost saving (priority)

- [ ] Add `SUSPENDED` state to state machine (distinct from `IDLE`; mic stays warm)
- [ ] Implement idle timer with activity hooks (user speech, AI speech, `sendText`, `resetIdleTimer`)
- [ ] Close WebSocket on suspend; keep `AudioPipeline` + pre-roll buffer running
- [ ] On local speech while `SUSPENDED` → `wake` → reconnect → flush pre-roll
- [ ] Emit `sleep-warning` (`suspendWarningMsBefore` ms before), `sleep`, `wake` events
- [ ] Test UI: show sleep timer, manual wake, `resetIdleTimer` button

**Manual test:** Connect → wait 45 s → confirm WS closed → speak → confirm fast reconnect (< 500 ms perceived) with no clipped first syllable.

### A2 — Transparent server passthrough

- [ ] In `handleServerMessage`, forward unhandled types as `message` events with raw payload
- [ ] Emit dedicated `tool-call` when server sends function/tool call shapes (match SentienceTool expectations)
- [ ] Add `itemId` to `user-speech-start` and user `transcript` events from server item IDs
- [ ] Test UI: raw message log panel (Advanced tab) for debugging passthrough

**Manual test:** Mock or live session with tool-enabled instructions (via test harness injection, not VoiceCore execution) — confirm events reach listener unchanged.

### A3 — Tuning panel on VoiceCore

- [ ] Extract `tuning-panel.js` + `tuning-spec.js` → `tuning.js` module
- [ ] Implement `voice.createTuningPanel()` returning mountable `HTMLElement`
- [ ] Simple tab: presets, key sliders, sleep timer display, connection state
- [ ] Advanced tab: waveform, frequency bands, gate values, raw message log
- [ ] Refactor `test-ui/app.js` to use `createTuningPanel()` only — no direct tuning imports

### A4 — Event & config polish

- [ ] Emit `config-change` on `setConfig()`
- [ ] Emit `mic-level` on existing level tick (or dedicated interval)
- [ ] Merge top-level + nested constructor options; include `suspendWarningMsBefore` in defaults
- [ ] Update `test-app/docs/design.md` to v0.2 (or reference this doc)

### A5 — Regression checklist (Stage A exit)

Run in Electron with and without Krisp:

| Scenario | Pass |
|----------|------|
| Connect → intro → disconnect | ☐ |
| Natural turn-taking (no clipped sentences) | ☐ |
| Barge-in during AI speech | ☐ |
| False barge recovery (speaker bleed) | ☐ |
| Hold to think defers turn-end | ☐ |
| Idle → `SUSPENDED` → wake on speech | ☐ |
| `resetIdleTimer()` prevents suspend | ☐ |
| `sleep-warning` fires `suspendWarningMsBefore` ms before suspend | ☐ |
| Pre-roll captures first syllable after wake | ☐ |
| Tuning panel live-applies all sliders | ☐ |
| `itemId` present on user transcripts (when server provides) | ☐ |
| Raw server messages forwarded (tool-call shape) | ☐ |

**Stage A exit:** All checklist items pass; no regressions vs GitHub v0.1 baseline.

---

## Stage B — Module extraction

Start only after Stage A exit. See also [test-app/docs/integration-plan.md](../test-app/docs/integration-plan.md) for SentienceTool wiring detail.

### B1 — Package layout

```
modules/voicecore/
├── src/                    # Publishable module (migrated from test-app)
│   ├── index.js
│   ├── …
│   └── tuning.js
├── test-app/               # Electron harness — imports from ../src/
│   ├── electron/
│   ├── test-ui/            # App shell only (no duplicated core)
│   └── package.json
├── package.json            # Exports ./src/index.js
└── docs/
```

Optional later split (not required for first module ship):

```
packages/core/              # @voicecore/core
packages/tuning-ui/           # @voicecore/tuning-ui (if tuning CSS grows large)
apps/test-electron/
```

**Recommendation:** Start with flat `src/` + `test-app/`; split packages only if bundle size or import boundaries demand it.

### B2 — Module `package.json` contract

```json
{
  "name": "voicecore",
  "version": "0.2.0",
  "type": "module",
  "main": "./src/index.js",
  "exports": {
    ".": "./src/index.js"
  },
  "peerDependencies": {
    "@livekit/krisp-noise-filter": "^0.4.0",
    "livekit-client": "^2.0.0"
  },
  "peerDependenciesMeta": {
    "@livekit/krisp-noise-filter": { "optional": true },
    "livekit-client": { "optional": true }
  }
}
```

### B3 — SentienceTool integration (phased)

| Phase | Work | Flag |
|-------|------|------|
| B3a | `SentienceVoiceSession` adapter skeleton | `?voicecore=1` |
| B3b | Wire transcript + itemId → conversation stitching | flag on |
| B3c | Passthrough tool-call events → existing tool-router | flag on |
| B3d | Mount `createTuningPanel()` in conversation chrome | flag on |
| B3e | Remove duplicate `audio.js`; default flag on | dogfood |

**Critical rule:** SentienceTool passes tool definitions via the locked `sessionExtensions` shape; VoiceCore forwards them in `session.update` but **never executes** tools.

```js
await voice.connect({
  apiKey,
  voice: "eve",
  instructions: buildLaunchInstructions(record),
  requestIntro: true,
  sessionExtensions: {
    tools: buildSessionToolDefinitions(record),
  },
});
```

VoiceCore emits `tool-call` / `message`; SentienceTool's tool-router responds with `function_call_output`.

### B4 — Module exit criteria

- [ ] `test-app/` imports exclusively from `../src/`
- [ ] `npm start` behaviour identical pre/post migration
- [ ] SentienceTool full session (tools, intro, art params) passes with flag on
- [ ] README documents public API matching this doc
- [ ] Git tag `v0.2.0`

---

## Implementation order (recommended PRs)

| PR | Scope | Stage |
|----|-------|-------|
| **PR1** | SessionManager + sleep/wake + events + test UI timer | A1 |
| **PR2** | Server passthrough + itemId on transcripts | A2 |
| **PR3** | `createTuningPanel()` + Simple/Advanced tabs | A3 |
| **PR4** | `config-change`, `mic-level`, constructor options, docs | A4 |
| **PR5** | Migrate `test-app/` → `src/`; test-app imports from src | B1 |
| **PR6** | SentienceTool adapter skeleton + flag | B3a |
| **PR7** | Full SentienceTool integration + deprecate duplicate audio | B3b–B3e |

Each PR keeps the Electron test app runnable. No SentienceTool changes until PR6.

---

## Open decisions

Pick before Stage B:

1. **Package naming:** `voicecore` vs `@voicecore/core` — decide at Stage B; `voicecore` is fine for private monorepo.

**Locked for v0.2:**

- State machine uses `SUSPENDED` (events remain `sleep` / `sleep-warning` / `wake` for consumers).
- Constructor accepts both top-level and nested `config`; merged into single effective config.
- `suspendWarningMsBefore: 5000` default when `idleTimeoutMs >= 30000`.
- `connect({ sessionExtensions: { tools } })` is the tool passthrough API shape.

---

## Future (post v0.2, not in scope)

- Local speech-to-text for tighter barge-in
- Speaker voice fingerprinting
- Full AudioWorklet migration (replace `ScriptProcessorNode`)
- Local wake word module
- Automated Playwright regression against mock WebSocket

---

## Related documents

| Document | Purpose |
|----------|---------|
| [test-app/docs/design.md](../test-app/docs/design.md) | v0.1 detailed design (barge-in, echo, VAD) — update after Stage A |
| [test-app/docs/integration-plan.md](../test-app/docs/integration-plan.md) | SentienceTool adapter and package split detail |
| [README.md](../README.md) | Quick start and layout |

---

*Baseline: GitHub `main` (v0.1). Target: v0.2 in Electron, then module + SentienceTool.*
