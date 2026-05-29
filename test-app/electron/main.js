/**
 * VoiceCore test app — Electron shell with embedded static server + mic permissions.
 */
import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./static-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {{ close: () => Promise<void>, baseUrl: string } | null} */
let staticServer = null;

/**
 * @param {string} url
 */
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    backgroundColor: "#0f1118",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(url);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function ensureStaticServer() {
  if (staticServer) return staticServer;

  const preferredPort = Number(process.env.PORT) || 5180;
  staticServer = await createStaticServer({
    root: PROJECT_ROOT,
    port: preferredPort,
    host: "127.0.0.1",
  });

  console.log(`[VoiceCore] UI server → ${staticServer.baseUrl}/test-ui/index.html`);
  return staticServer;
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      callback(true);
      return;
    }
    callback(false);
  });

  try {
    const server = await ensureStaticServer();
    const uiUrl = `${server.baseUrl}/test-ui/index.html`;
    createWindow(uiUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[VoiceCore] Failed to start UI server:", message);
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const server = await ensureStaticServer();
      createWindow(`${server.baseUrl}/test-ui/index.html`);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", async () => {
  if (staticServer) {
    try {
      await staticServer.close();
    } catch {
      /* ignore */
    }
    staticServer = null;
  }
});
