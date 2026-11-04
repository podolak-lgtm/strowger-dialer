// The Strowger engine: jambonz webhooks, the internal API, the realtime hub,
// and (Phase 3) the pacing loop and workers.
import cors from "@fastify/cors";
import { prisma } from "@strowger/db";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config";
import { registerInternalRoutes } from "./internal/routes";
import { registerJambonzRoutes } from "./jambonz/routes";
import { log } from "./log";
import { attachRealtime } from "./realtime";
import { redis } from "./redis";

const app = Fastify({ loggerInstance: log }) as unknown as FastifyInstance;

await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });

app.get("/health", async () => {
  const [db, cache] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping()]);
  const ok = db.status === "fulfilled" && cache.status === "fulfilled";
  return { ok, db: db.status, redis: cache.status, telephony: Boolean(config.JAMBONZ_API_KEY), version: process.env.npm_package_version ?? "dev" };
});

/** Server-to-server calls from the web app carry the internal key. */
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/internal/")) return;
  if (req.headers["x-engine-key"] !== config.ENGINE_INTERNAL_KEY) {
    reply.code(401).send({ error: "unauthorised" });
  }
});

await registerJambonzRoutes(app);
await registerInternalRoutes(app);

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
log.info({ port: config.ENGINE_PORT, telephony: Boolean(config.JAMBONZ_API_KEY) }, "engine listening");
