#!/usr/bin/env node
// Phone <-> PC bridge: a zero-dependency Node server that hosts a web page on
// your local Wi-Fi address. Open it on both devices to share text and files.
//
//   node server.js [--port 8080] [--no-key]
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// ---------- config ----------
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argVal("--port", process.env.PORT || 8080));
const REQUIRE_KEY = !args.includes("--no-key");
const KEY = crypto.randomBytes(4).toString("hex"); // pairing key, shown in the URL / QR
const MAX_UPLOAD = 4 * 1024 ** 3; // 4 GB per file
const MAX_ITEMS = 300;
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));

// ---------- LAN addresses ----------
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      const priv =
        /^192\.168\./.test(ni.address) ||
        /^10\./.test(ni.address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ni.address);
      const virtual = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|utun|lo)/i.test(name);
      out.push({ iface: name, address: ni.address, score: (priv ? 2 : 0) - (virtual ? 3 : 0) });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

const urlFor = (ip) => `http://${ip}:${PORT}/${REQUIRE_KEY ? `?key=${KEY}` : ""}`;

// ---------- state ----------
/** @type {{id:string,kind:'text'|'file',from:string,time:number,text?:string,name?:string,size?:number,mime?:string,path?:string}[]} */
let items = [];
const clients = new Set(); // SSE responses

const publicItem = ({ path: _p, ...rest }) => rest;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function addItem(item) {
  items.push(item);
  while (items.length > MAX_ITEMS) removeFile(items.shift());
  broadcast("add", publicItem(item));
}

function removeFile(item) {
  if (item && item.path) fs.unlink(item.path, () => {});
}

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const safeName = (n) =>
  String(n || "file")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 180) || "file";

const cleanFrom = (f) => (f === "phone" || f === "pc" ? f : "other");

function authorized(req, url) {
  if (!REQUIRE_KEY) return { ok: true };
  const cookie = /(?:^|;\s*)bridge=([0-9a-f]+)/.exec(req.headers.cookie || "");
  if (cookie && cookie[1] === KEY) return { ok: true };
  if (url.searchParams.get("key") === KEY) return { ok: true, setCookie: true };
  return { ok: false };
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  const auth = authorized(req, url);
  if (!auth.ok) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Access key missing. Open the link (or scan the QR code) shown in the bridge terminal.");
  }
  if (auth.setCookie) {
    // remember the key, then drop it from the address bar
    res.writeHead(302, {
      "Set-Cookie": `bridge=${KEY}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      Location: p === "/" ? "/" : p,
    });
    return res.end();
  }

  // --- API ---
  if (p === "/api/info" && req.method === "GET") {
    return json(res, 200, {
      port: PORT,
      host: os.hostname(),
      links: lanAddresses().map((a) => ({ iface: a.iface, ip: a.address, url: urlFor(a.address) })),
    });
  }

  if (p === "/api/items" && req.method === "GET") {
    return json(res, 200, items.map(publicItem));
  }

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    clients.add(res);
    broadcast("peers", { count: clients.size });
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
      broadcast("peers", { count: clients.size });
    });
    return;
  }

  if (p === "/api/text" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || "");
      if (!text.trim()) return json(res, 400, { error: "Empty text" });
      addItem({
        id: crypto.randomUUID(),
        kind: "text",
        from: cleanFrom(body.from),
        time: Date.now(),
        text: text.slice(0, 200000),
      });
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (p === "/api/upload" && req.method === "POST") {
    const name = safeName(decodeURIComponent(url.searchParams.get("name") || "file"));
    const from = cleanFrom(url.searchParams.get("from"));
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > MAX_UPLOAD) return json(res, 413, { error: "File too large" });

    const id = crypto.randomUUID();
    const dest = path.join(UPLOAD_DIR, id);
    const out = fs.createWriteStream(dest);
    let size = 0;
    let failed = false;
    const fail = (code, msg) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(dest, () => {});
      if (!res.headersSent) json(res, code, { error: msg });
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        fail(413, "File too large");
        req.destroy();
      }
    });
    req.on("aborted", () => fail(499, "Upload aborted"));
    req.on("error", () => fail(500, "Upload failed"));
    out.on("error", () => fail(500, "Could not save file"));
    out.on("finish", () => {
      if (failed) return;
      addItem({
        id,
        kind: "file",
        from,
        time: Date.now(),
        name,
        size,
        mime: String(req.headers["content-type"] || "application/octet-stream"),
        path: dest,
      });
      json(res, 200, { ok: true, id });
    });
    return req.pipe(out);
  }

  let m;
  if ((m = /^\/api\/items\/([0-9a-f-]{36})$/.exec(p)) && req.method === "DELETE") {
    const i = items.findIndex((x) => x.id === m[1]);
    if (i < 0) return json(res, 404, { error: "Not found" });
    removeFile(items[i]);
    items.splice(i, 1);
    broadcast("remove", { id: m[1] });
    return json(res, 200, { ok: true });
  }

  if (p === "/api/items" && req.method === "DELETE") {
    items.forEach(removeFile);
    items = [];
    broadcast("clear", {});
    return json(res, 200, { ok: true });
  }

  // --- file download ---
  if ((m = /^\/files\/([0-9a-f-]{36})$/.exec(p)) && req.method === "GET") {
    const item = items.find((x) => x.id === m[1] && x.kind === "file");
    if (!item) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const inline = url.searchParams.has("inline") && /^(image|video|audio)\//.test(item.mime);
    res.writeHead(200, {
      "Content-Type": inline ? item.mime : "application/octet-stream",
      "Content-Length": item.size,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    return fs.createReadStream(item.path).pipe(res);
  }

  // --- static ---
  if (req.method === "GET") {
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (file.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      return fs.createReadStream(file).pipe(res);
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "Server error" });
  });
});
server.requestTimeout = 0; // allow long uploads on slow Wi-Fi

server.listen(PORT, "0.0.0.0", () => {
  const addrs = lanAddresses();
  console.log("\n  Phone <-> PC Bridge is running\n");
  if (addrs.length === 0) {
    console.log("  No Wi-Fi/LAN address found. Connect to a network and restart.\n");
  } else {
    console.log("  Open this link on your phone (same Wi-Fi) — or scan the QR on the PC page:\n");
    for (const a of addrs) console.log(`    ${urlFor(a.address)}   (${a.iface})`);
  }
  console.log(`\n  On this PC:  ${urlFor("localhost")}`);
  console.log(`  Received files are kept in: ${UPLOAD_DIR}`);
  console.log("  Press Ctrl+C to stop.\n");
});

function shutdown() {
  for (const res of clients) res.end();
  try {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
