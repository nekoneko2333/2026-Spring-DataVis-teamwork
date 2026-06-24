import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const root = resolve("dist");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bin": "application/octet-stream",
};

createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url || "/", `http://${host}`).pathname);
  if (pathname === "/") pathname = "/index.html";

  let file = resolve(join(root, pathname));
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, "index.html");
  }

  res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
  createReadStream(file)
    .on("error", () => {
      res.statusCode = 500;
      res.end("server error");
    })
    .pipe(res);
}).listen(port, host, () => {
  console.log(`Preview server: http://${host}:${port}/`);
});
