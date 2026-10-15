// Field Twin Violet API v1
// BLUE PHONE: Redis connection, optional so the service still boots without it.
import Redis from "ioredis";

export const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { family: 0, maxRetriesPerRequest: 3 })
  : null;

if (redis) redis.on("error", (err) => console.error("redis error", err.message));
