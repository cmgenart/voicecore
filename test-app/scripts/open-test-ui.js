#!/usr/bin/env node
/**
 * Open the test UI in the default browser (exits immediately — does not block).
 */
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT) || 5180;
const url = process.env.VOICECORE_DEV_URL || `http://127.0.0.1:${PORT}/test-ui/index.html`;

if (process.platform === "win32") {
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
} else if (process.platform === "darwin") {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
} else {
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

console.log(`Opened ${url}`);
console.log("Ensure the dev server is running: npm run dev");
