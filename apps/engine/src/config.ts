import { readEnv } from "@strowger/shared/env";
import { z } from "zod";

export const config = readEnv({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ENGINE_PORT: z.coerce.number().default(4000),
  ENGINE_PUBLIC_URL: z.string().default("http://localhost:4000"),
  /** Shared secret between web and engine for server-to-server calls. */
  ENGINE_INTERNAL_KEY: z.string().min(32),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});
