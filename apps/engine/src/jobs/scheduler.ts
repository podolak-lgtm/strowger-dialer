// Periodic work. One engine instance runs each job at a time, by a Redis lock;
// more instances simply find the lock taken. Phase 3 adds the pacing loop and
// hopper builder here.
import { prisma } from "@strowger/db";
import { log } from "../log";
import { redis } from "../redis";
import { scrubAllTenants } from "../scrub/job";
import { deliverPending } from "../webhooks/deliver";
import { nightlyRecordings } from "../recordings/export";
import { queueTick } from "../inbound/router";
import { syncPendingOrders } from "../provision";
import { settlePeriodWagers, weeklyTopUp } from "../games";

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

async function withLock(name: string, ttlMs: number, fn: () => Promise<unknown>): Promise<void> {
  const key = `lock:job:${name}`;
  const got = await redis.set(key, String(process.pid), "PX", ttlMs, "NX");
  if (!got) return;
  try {
    await fn();
  } catch (e) {
    log.error({ err: e, job: name }, "job failed");
  } finally {
    await redis.del(key).catch(() => undefined);
  }
}

/** Once a night (first tick after 06:00 UTC, when US dialing is quiet): export then sweep recordings. */
async function nightly(): Promise<void> {
  const now = new Date();
  if (now.getUTCHours() < 6) return;
  const today = now.toISOString().slice(0, 10);
  const last = await redis.get("job:nightlyRecordings:last");
  if (last === today) return;
  await nightlyRecordings();
  await redis.set("job:nightlyRecordings:last", today);
}

/** Reset per-day counters at the first tick after midnight UTC. */
async function dailyReset(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const last = await redis.get("job:dailyReset:last");
  if (last === today) return;
  await prisma.callerIdNumber.updateMany({ data: { usedToday: 0, shortCallsToday: 0 } });
  await redis.set("job:dailyReset:last", today);
  log.info({ today }, "daily counters reset");
}

/** Monday (UTC) first tick: every agent back to the weekly allowance. */
async function mondayTopUp(): Promise<void> {
  const now = new Date();
  if (now.getUTCDay() !== 1) return;
  const key = now.toISOString().slice(0, 10);
  if ((await redis.get("job:weeklyTopUp:last")) === key) return;
  await weeklyTopUp(now);
  await redis.set("job:weeklyTopUp:last", key);
}

const JOBS: Job[] = [
  { name: "scrub", everyMs: 2 * 60_000, run: scrubAllTenants },
  { name: "dailyReset", everyMs: 10 * 60_000, run: dailyReset },
  { name: "webhooks", everyMs: 30_000, run: deliverPending },
  { name: "nightlyRecordings", everyMs: 15 * 60_000, run: nightly },
  { name: "queues", everyMs: 1_000, run: queueTick },
  { name: "numberOrders", everyMs: 3 * 60_000, run: syncPendingOrders },
  { name: "wagers", everyMs: 15 * 60_000, run: () => settlePeriodWagers() },
  { name: "weeklyTopUp", everyMs: 10 * 60_000, run: mondayTopUp },
];

export function startScheduler(): () => void {
  const timers = JOBS.map((job) => {
    const tick = () => void withLock(job.name, Math.max(900, job.everyMs - 1000), job.run);
    const t = setInterval(tick, job.everyMs);
    setTimeout(tick, 5_000 + Math.random() * 5_000);
    return t;
  });
  log.info({ jobs: JOBS.map((j) => j.name) }, "scheduler started");
  return () => timers.forEach(clearInterval);
}
