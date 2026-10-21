"use strict";
// Appdock server: static site + JSON API, built-in Node modules only.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "apps.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
const MAX_APPS = 2000;
const MAX_BODY = 20 * 1024;

const CATS = ["Browsers","Communication","Media","Productivity","Developer","Creative","Security","Utilities","Games"];
const LICENSES = ["Free","Open source","Freemium","Paid"];
const PLATS = ["Windows","Mac","Linux","Android"];
const MIME = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon", ".txt":"text/plain; charset=utf-8" };

fs.mkdirSync(DATA_DIR, { recursive: true });
let apps = [];
try { apps = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); if (!Array.isArray(apps)) apps = []; } catch (e) { apps = []; }

// One write at a time; write a temp file, then rename, so a crash cannot leave a half-written file.
let writing = Promise.resolve();
function persist() {
  writing = writing.then(async () => {
    const tmp = DATA_FILE + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(apps));
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch(err => console.error("save failed:", err));
  return writing;
}

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function validUrl(u) {
  if (!/^https:\/\/[^\s"'<>]+$/.test(u)) return false;
  try { return new URL(u).hostname.includes("."); } catch (e) { return false; }
}
function clean(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Send the app details as JSON." };
  const s = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const app = {
    name: s(body.name, 60), dev: s(body.dev, 60), tag: s(body.tag, 140),
    desc: s(body.desc, 1200), url: s(body.url, 300),
    cat: CATS.includes(body.cat) ? body.cat : "Utilities",
    lic: LICENSES.includes(body.lic) ? body.lic : "Free",
    plats: Array.isArray(body.plats) ? PLATS.filter(p => body.plats.includes(p)) : []
  };
  if (!app.name || !app.dev || !app.tag || !app.desc) return { error: "Fill in the name, developer, summary and description." };
  if (!app.plats.length) return { error: "Choose at least one platform." };
  if (!validUrl(app.url)) return { error: "Enter a full download link that starts with https://" };
  return { app };
}

// In-memory limiter: 10 submissions per IP per hour.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600000);
  if (list.length >= 10) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list); return false;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some(t => now - t < 3600000)) hits.delete(ip); }, 600000).unref();

const publicView = a => ({ id: a.id, name: a.name, dev: a.dev, cat: a.cat, lic: a.lic, plats: a.plats, tag: a.tag, desc: a.desc, url: a.url, t: a.t });

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject({ status: 413, error: "That is too large." }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject({ status: 400, error: "Send valid JSON." }); } });
    req.on("error", () => reject({ status: 400, error: "Request failed." }));
  });
}
const clientIp = req => (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",").pop().trim()) || req.socket.remoteAddress || "unknown";

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api","apps",id?]
  if (parts[1] !== "apps" || parts.length > 3) return send(res, 404, { error: "Not found." });
  const id = parts[2];

  if (!id && req.method === "GET") return send(res, 200, apps.map(publicView));

  if (!id && req.method === "POST") {
    if (limited(clientIp(req))) return send(res, 429, { error: "Too many submissions. Try again in an hour." });
    if (apps.length >= MAX_APPS) return send(res, 507, { error: "The catalog is full." });
    let body;
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: e.error || "Bad request." }); }
    const { app, error } = clean(body);
    if (error) return send(res, 400, { error });
    const slug = app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "app";
    const newId = slug + "-" + crypto.randomBytes(3).toString("hex");
    const key = crypto.randomBytes(16).toString("hex");
    const full = { id: newId, ...app, t: Date.now(), keyHash: sha(key).toString("hex") };
    apps.push(full);
    await persist();
    return send(res, 201, { id: newId, key, app: publicView(full) });
  }

  if (id && req.method === "DELETE") {
    const i = apps.findIndex(a => a.id === id);
    if (i < 0) return send(res, 404, { error: "Not found." });
    const owner = String(req.headers["x-owner-key"] || "");
    const admin = String(req.headers["x-admin-token"] || "");
    const okOwner = owner && safeEqual(sha(owner), Buffer.from(apps[i].keyHash || "", "hex"));
    const okAdmin = ADMIN_TOKEN && admin && safeEqual(sha(admin), sha(ADMIN_TOKEN));
    if (!okOwner && !okAdmin) return send(res, 403, { error: "Not allowed." });
    apps.splice(i, 1);
    await persist();
    return send(res, 200, { ok: true });
  }

  return send(res, 405, { error: "Method not allowed." });
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    api(req, res, url).catch(err => { console.error(err); if (!res.headersSent) send(res, 500, { error: "Server error." }); });
  } else serveStatic(req, res, url);
}).listen(PORT, () => console.log("Appdock running on port " + PORT));
