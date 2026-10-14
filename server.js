// Field Twin Violet API v1
// RED PHONE: photo reader for Field Twin Violet. Holds the Anthropic key so the phone never does.
// RED PHONE: Dropbox archive removed, photos live in the Supabase violet-photos bucket.
// Endpoints: GET /, GET /health, POST /extract
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { redis } from "./redis.js";
import { visionReady, extractFromImage } from "./vision.js";
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

function tokenOk(req) {
  if (!API_TOKEN) return false;
  const given = String(req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
  if (!tokenOk(req)) return res.status(401).json({ error: "token rejected" });
  next();
}

function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

const wrap = (handler) => (req, res, next) => handler(req, res).catch(next);

app.get("/", (req, res) => {
  res.json({ name: "field-twin-violet-api", version: "1.0.0", endpoints: ["/health", "/extract"] });
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
      ok: visionReady() && Boolean(API_TOKEN),
      keyConfigured: visionReady(),
      tokenConfigured: Boolean(API_TOKEN),
      redis: redisState,
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

    // RED PHONE: same photo and barcodes never get analyzed or billed twice.
    const hash = crypto.createHash("sha256").update(img.base64).update(JSON.stringify(barcodes)).digest("hex");
    const cacheKey = `violet:extract:${hash}`;
    if (redis) {
      const hit = await redis.get(cacheKey).catch(() => null);
      if (hit) return res.json({ result: JSON.parse(hit), cached: true });
      const rateKey = `violet:rate:${new Date().toISOString().slice(0, 13)}`;
      const calls = await redis.incr(rateKey).catch(() => 0);
      if (calls === 1) await redis.expire(rateKey, 3600).catch(() => {});
      if (calls > EXTRACTS_PER_HOUR) return res.status(429).json({ error: "hourly photo limit reached, try again later" });
    }

    const result = await extractFromImage({ ...img, barcodes });
    if (redis) await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_DAYS * 86400).catch(() => {});
    res.json({ result, cached: false });
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
