import { Redis } from "ioredis";
import { config } from "./config";

export function makeRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
}

export const redis = makeRedis();
