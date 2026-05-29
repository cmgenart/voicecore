#!/usr/bin/env node
/**
 * Standalone static server (browser-only testing). Electron embeds the same server in main.js.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../electron/static-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 5180;

const server = await createStaticServer({ root: ROOT, port: PORT });

console.log(`VoiceCore dev server → ${server.baseUrl}/test-ui/index.html`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
