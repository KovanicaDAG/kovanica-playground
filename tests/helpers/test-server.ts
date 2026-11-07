import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");

function needsBuild(distDir: string): boolean {
  const indexHtml = path.join(distDir, "index.html");
  if (!fs.existsSync(indexHtml)) return true;

  const distMtime = fs.statSync(indexHtml).mtimeMs;
  const srcFiles = [
    path.join(projectRoot, "src", "App.tsx"),
    path.join(projectRoot, "src", "methods.ts"),
    path.join(projectRoot, "src", "main.tsx"),
  ];
  return srcFiles.some((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs > distMtime);
}

export async function startTestServer(): Promise<TestServer> {
  const distDir = path.resolve(projectRoot, "dist");
  if (needsBuild(distDir)) {
    execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });
  }

  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(
      new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname,
    );
    if (reqPath === "/") reqPath = "/index.html";

    let filePath = path.join(distDir, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, "index.html");
    }

    try {
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      });
      res.end(content);
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Internal Server Error: ${err?.message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }

  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
