# VoiceCore

Speech I/O module for **xAI Realtime** (WebSocket + PCM16), with an Electron test harness for tuning acoustics without touching SentienceTool.

## Layout

```
modules/voicecore/
├── src/          # Publishable module (empty — code migrates here from test-app)
├── test-app/     # Standalone Electron test harness (flat layout: core .js at test-app root)
├── package.json  # Workspace root; scripts delegate to test-app
└── README.md
```

| Folder | Purpose |
|--------|---------|
| **`src/`** | Future home of the reusable VoiceCore package (`VoiceCore`, `AudioPipeline`, transport, config). Empty until extraction from the test app. |
| **`test-app/`** | Full Electron app: mic, playback, tuning drawer, Krisp, regression UI. Core module files (`index.js`, `config.js`, …) live at the test-app root alongside `electron/` and `test-ui/`. |

## Quick start (test app)

```bash
cd modules/voicecore/test-app
npm install
npm start
```

Or from this folder:

```bash
cd modules/voicecore
npm start
```

Browser-only (no Electron):

```bash
cd modules/voicecore/test-app
npm run dev
# open http://127.0.0.1:5180/test-ui/
```

## Integration

SentienceTool will depend on `src/` once the module is extracted. Until then, the test app under `test-app/` is the source of truth for voice behaviour.

See `test-app/docs/design.md` and `test-app/docs/integration-plan.md` for architecture and SentienceTool wiring plans.

## Git

No repository initialized here yet — folder layout only.
