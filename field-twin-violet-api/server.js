// Field Twin Violet API v2
// BLUE PHONE: photo reader and archive relay for Field Twin Violet. Holds the Anthropic key so the phone never does.
// Endpoints: GET /, GET /health, POST /extract, POST /archive
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { redis } from "./redis.js";
import { visionReady, extractFromImage } from "./vision.js";
import { dropboxReady, archivePhoto } from "./dropbox.js";
import { setupDatabase, schemaState } from "./db.js";

const app = express();
app.set("trust proxy", 2);
app.use(express.json({ limit: "14mb" }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const API_TOKEN = process.env.API_TOKEN || "";
const EXTRACTS_PER_HOUR = Number(process.env.EXTRACTS_PER_HOUR) || 150;
const CACHE_DAYS = 30;

// BLUE PHONE: a signed in Field Twin Violet user is let in by their Supabase session, so the phone needs no pasted token.
const SUPABASE_URL = process.env.SUPABASE_URL || "https://zasyjjoypkpvyqdueums.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_iFsIWHo1XN6bO6S5z5vJEg_k6IRq94z";
const sessionCache = new Map();

function staticTokenOk(given) {
  if (!API_TOKEN) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

async function sessionOk(given) {
  if (!given || given.split(".").length !== 3) return false;
  const key = crypto.createHash("sha256").update(given).digest("hex");
  const hit = sessionCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + given } });
    ok = r.ok;
  } catch {
    ok = false;
  }
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(key, { ok, until: Date.now() + (ok ? 300000 : 30000) });
  return ok;
}

async function tokenOk(req) {
  const given = String(req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return staticTokenOk(given) || (await sessionOk(given));
}

function requireToken(req, res, next) {
  tokenOk(req)
    .then((ok) => (ok ? next() : res.status(401).json({ error: "token rejected" })))
    .catch(next);
}

function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);

app.get("/", (req, res) => {
  res.json({ name: "field-twin-violet-api", version: "2.0.0", endpoints: ["/health", "/extract", "/archive"] });
});

app.get(
  "/health",
  wrap(async (req, res) => {
    let redisState = redis ? "connected" : "not set";
    if (redis) {
      try {
        await redis.ping();
      } catch {
        redisState = "unreachable";
      }
    }
    res.json({
      ok: visionReady(),
      keyConfigured: visionReady(),
      tokenConfigured: Boolean(API_TOKEN),
      redis: redisState,
      dropbox: dropboxReady() ? "ready" : "not set",
      schema: schemaState.status,
      schemaFailures: schemaState.failed,
    });
  })
);

app.post(
  "/extract",
  requireToken,
  wrap(async (req, res) => {
    if (req.body && req.body.check) return res.json({ ok: true });
    if (!visionReady()) return res.status(503).json({ error: "vision key missing on the service" });
    const img = parseImage(req.body && req.body.image);
    if (!img) return res.status(400).json({ error: "image must be a base64 data URL" });
    const barcodes = Array.isArray(req.body.barcodes) ? req.body.barcodes : [];
    const purpose = req.body.purpose === "order" ? "order" : "";

    // BLUE PHONE: same photo and barcodes never get analyzed or billed twice.
    const hash = crypto.createHash("sha256").update(img.base64).update(JSON.stringify(barcodes)).update(purpose).digest("hex");
    const cacheKey = `violet:extract:${hash}`;
    if (redis) {
      const hit = await redis.get(cacheKey).catch(() => null);
      if (hit) return res.json({ result: JSON.parse(hit), cached: true });
      const rateKey = `violet:rate:${new Date().toISOString().slice(0, 13)}`;
      const calls = await redis.incr(rateKey).catch(() => 0);
      if (calls === 1) await redis.expire(rateKey, 3600).catch(() => {});
      if (calls > EXTRACTS_PER_HOUR) return res.status(429).json({ error: "hourly photo limit reached, try again later" });
    }

    const result = await extractFromImage({ ...img, barcodes, purpose });
    if (redis) await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_DAYS * 86400).catch(() => {});
    res.json({ result, cached: false });
  })
);

app.post(
  "/archive",
  requireToken,
  wrap(async (req, res) => {
    if (!dropboxReady()) return res.status(503).json({ error: "dropbox not set up" });
    const img = parseImage(req.body && req.body.image);
    const path = String((req.body && req.body.path) || "");
    if (!img) return res.status(400).json({ error: "image must be a base64 data URL" });
    if (!/^[A-Za-z0-9/_.-]{5,200}$/.test(path) || path.includes("..")) {
      return res.status(400).json({ error: "bad path" });
    }
    await archivePhoto(path, Buffer.from(img.base64, "base64"));
    res.json({ ok: true });
  })
);

app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.too.large") return res.status(413).json({ error: "photo too large" });
  res.status(500).json({ error: err.message || "server error" });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`field-twin-violet-api listening on ${port}`);
  setupDatabase().catch((err) => console.error("schema setup crashed", err.message));
});
