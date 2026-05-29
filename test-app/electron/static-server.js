/**
 * Local static server for test-ui, src modules, and /npm (node_modules).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * @param {string} root Project root (voicecore/)
 * @param {string} urlPath
 * @returns {string|null}
 */
export function resolveStaticPath(root, urlPath) {
  if (urlPath === "/" || urlPath === "/test-ui" || urlPath === "/test-ui/") {
    urlPath = "/test-ui/index.html";
  } else if (urlPath.endsWith("/")) {
    urlPath += "index.html";
  }

  if (urlPath.startsWith("/npm/")) {
    const rel = urlPath.slice("/npm/".length);
    const filePath = path.normalize(path.join(root, "node_modules", rel));
    const modulesRoot = path.normalize(path.join(root, "node_modules") + path.sep);
    if (!filePath.startsWith(modulesRoot)) return null;
    return filePath;
  }

  const filePath = path.normalize(path.join(root, urlPath));
  const rootNorm = path.normalize(root + path.sep);
  if (!filePath.startsWith(rootNorm) && filePath !== root) return null;
  return filePath;
}

/**
 * @param {{ root: string, port?: number, host?: string, maxPortAttempts?: number }} opts
 * @returns {Promise<{ server: import('node:http').Server, port: number, host: string, baseUrl: string, close: () => Promise<void> }>}
 */
export function createStaticServer(opts) {
  const root = opts.root;
  const host = opts.host ?? "127.0.0.1";
  const maxAttempts = opts.maxPortAttempts ?? 8;
  let startPort = opts.port ?? 5180;

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const filePath = resolveStaticPath(root, urlPath);

    if (!filePath) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === "EISDIR") {
          fs.readFile(path.join(filePath, "index.html"), (err2, data2) => {
            if (err2) {
              res.writeHead(404);
              res.end("Not found");
              return;
            }
            res.writeHead(200, { "Content-Type": MIME[".html"] });
            res.end(data2);
          });
          return;
        }
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    let port = startPort;
    let attemptsLeft = maxAttempts;

    const tryListen = () => {
      const onError = (err) => {
        server.off("listening", onListening);
        if (/** @type {NodeJS.ErrnoException} */ (err).code === "EADDRINUSE" && attemptsLeft > 0) {
          attemptsLeft -= 1;
          port += 1;
          tryListen();
          return;
        }
        reject(err);
      };

      const onListening = () => {
        server.off("error", onError);
        const baseUrl = `http://${host}:${port}`;
        resolve({
          server,
          port,
          host,
          baseUrl,
          close: () =>
            new Promise((res, rej) => {
              server.close((e) => (e ? rej(e) : res()));
            }),
        });
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };

    tryListen();
  });
}
