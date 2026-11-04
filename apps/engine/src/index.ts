// The Strowger engine: pacing loop, jambonz webhooks, realtime hub, workers.
// Phase 0 ships the process shell: HTTP + WebSocket + health, with the
// internal API the web app calls. Each later phase adds a module here.
import cors from "@fastify/cors";
import { prisma } from "@strowger/db";
import Fastify from "fastify";
import { config } from "./config";
import { log } from "./log";
import { redis } from "./redis";
import { attachRealtime } from "./realtime";

const app = Fastify({ loggerInstance: log });

await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });

app.get("/health", async () => {
  const [db, cache] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping()]);
  const ok = db.status === "fulfilled" && cache.status === "fulfilled";
  return { ok, db: db.status, redis: cache.status, version: process.env.npm_package_version ?? "dev" };
});

/** Server-to-server calls from the web app carry the internal key. */
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/internal/")) return;
  const key = req.headers["x-engine-key"];
  if (key !== config.ENGINE_INTERNAL_KEY) {
    reply.code(401).send({ error: "unauthorised" });
  }
});

app.get("/internal/ping", async () => ({ pong: true }));

const io = attachRealtime(app.server);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  io.close();
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.ENGINE_PORT, host: "0.0.0.0" });
log.info({ port: config.ENGINE_PORT }, "engine listening");
