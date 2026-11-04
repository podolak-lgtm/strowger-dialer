// The Strowger engine: jambonz webhooks, the internal API, the realtime hub,
// and (Phase 3) the pacing loop and workers.
import cors from "@fastify/cors";
import { prisma } from "@strowger/db";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config";
import { registerInternalRoutes } from "./internal/routes";
import { registerJambonzRoutes } from "./jambonz/routes";
import { registerRecorder } from "./inbound/recorder";
import { startScheduler } from "./jobs/scheduler";
import { startPacing } from "./dialer/pacing";
import { jambonz, jambonzConfigured } from "./jambonz/client";
import { classifyReply, smsAiConfigured } from "./sms/classify";
import { log } from "./log";
import { attachRealtime } from "./realtime";
import { redis } from "./redis";

const app = Fastify({ loggerInstance: log }) as unknown as FastifyInstance;

await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });

// jambonz credential check, cached a minute so health polling costs one API read per minute.
let jambonzAuth: { at: number; value: string } = { at: 0, value: "unchecked" };
async function jambonzAuthStatus(): Promise<string> {
  if (!jambonzConfigured) return "not configured";
  if (Date.now() - jambonzAuth.at < 60_000) return jambonzAuth.value;
  try {
    await jambonz.calls.count();
    jambonzAuth = { at: Date.now(), value: "ok" };
  } catch (e) {
    jambonzAuth = { at: Date.now(), value: `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
  return jambonzAuth.value;
}

// AI reply reading: one real classification, cached an hour, proves the key and the model.
let smsAi: { at: number; value: string } = { at: 0, value: "unchecked" };
async function smsAiStatus(): Promise<string> {
  if (!smsAiConfigured) return "not configured";
  if (Date.now() - smsAi.at < 3_600_000) return smsAi.value;
  const r = await classifyReply({ body: "please dont call me again" });
  smsAi = { at: Date.now(), value: r ? `ok (${r.intent} ${Math.round(r.confidence * 100)}%)` : "error: see engine logs" };
  return smsAi.value;
}

app.get("/health", async () => {
  const [db, cache, auth, ai] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, redis.ping(), jambonzAuthStatus(), smsAiStatus()]);
  const ok = db.status === "fulfilled" && cache.status === "fulfilled";
  return {
    ok,
    db: db.status,
    redis: cache.status,
    telephony: Boolean(config.JAMBONZ_API_KEY),
    jambonzAuth: auth.status === "fulfilled" ? auth.value : "error",
    applicationSid: Boolean(config.JAMBONZ_APPLICATION_SID),
    smsAi: ai.status === "fulfilled" ? ai.value : "error",
    sipRealm: config.JAMBONZ_SIP_REALM ?? null,
    version: process.env.npm_package_version ?? "dev",
  };
});

/** Server-to-server calls from the web app carry the internal key. */
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/internal/")) return;
  if (req.headers["x-engine-key"] !== config.ENGINE_INTERNAL_KEY) {
    reply.code(401).send({ error: "unauthorised" });
  }
});

await registerRecorder(app);
await registerJambonzRoutes(app);
await registerInternalRoutes(app);

const io = attachRealtime(app.server);
const stopScheduler = startScheduler();
const stopPacing = startPacing();

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  stopScheduler();
  stopPacing();
  io.close();
  await app.close();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
};
// A rejected promise in a background job must not take the whole engine down.
process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.ENGINE_PORT, host: "0.0.0.0" });
log.info({ port: config.ENGINE_PORT, telephony: Boolean(config.JAMBONZ_API_KEY) }, "engine listening");
