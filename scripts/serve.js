// Tiny static server for previewing dist/ locally: npm run dev
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const port = process.env.PORT || 8080;
const types = {
  ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".wasm": "application/wasm",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

http.createServer((req, res) => {
  let p = path.join(dist, decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(dist)) return res.writeHead(403).end();
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
  fs.readFile(p, (err, data) => {
    if (err) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": types[path.extname(p).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}).listen(port, () => console.log(`Serving at http://localhost:${port}`));
