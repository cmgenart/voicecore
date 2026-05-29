#!/usr/bin/env node
/**
 * @deprecated Use `npm start` (electron .) — server is embedded in Electron main.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require("electron");
} catch {
  console.error("Electron not installed. Run: npm install");
  process.exit(1);
}

console.log("[voicecore] Launching Electron (embedded UI server)…");
const proc = spawn(electronPath, ["."], { cwd: root, stdio: "inherit" });
proc.on("exit", (code) => process.exit(code ?? 0));
