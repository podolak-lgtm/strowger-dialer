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

  // jambonz. Without API key + account SID the engine runs but cannot dial.
  JAMBONZ_API_URL: z.string().default("https://api.jambonz.cloud"),
  JAMBONZ_API_KEY: z.string().optional(),
  JAMBONZ_ACCOUNT_SID: z.string().optional(),
  /** The jambonz application whose hooks point at this engine. */
  JAMBONZ_APPLICATION_SID: z.string().optional(),
  JAMBONZ_SIP_REALM: z.string().optional(),
  /** Webhook signing secret from the jambonz account (header Jambonz-Signature). */
  JAMBONZ_WEBHOOK: z.string().optional(),
  /** Refuse unsigned webhooks. Off until the signature format is confirmed live. */
  JAMBONZ_REQUIRE_SIGNATURE: z.coerce.boolean().default(false),
  /** Carrier (BYOC) name in jambonz for outbound PSTN calls; empty = account default. */
  JAMBONZ_CARRIER: z.string().optional(),

  /** Public web URL, for links in texts (callback page). */
  WEB_PUBLIC_URL: z.string().default("http://localhost:3000"),
  // SMS: commio | telnyx | log
  SMS_PROVIDER: z.enum(["commio", "telnyx", "log"]).default("log"),
  COMMIO_API_URL: z.string().default("https://api.thinq.com"),
  COMMIO_ACCOUNT_ID: z.string().optional(),
  COMMIO_USERNAME: z.string().optional(),
  COMMIO_TOKEN: z.string().optional(),
  TELNYX_API_KEY: z.string().optional(),

  // Crossbar scrub (optional). Without both, leads are marked CLEAN with the reason "No scrub source configured".
  CROSSBAR_URL: z.string().optional(),
  CROSSBAR_AGENT_KEY: z.string().optional(),
  /** Run the paid SubscriberVerify layer, not only Crossbar's own lists. */
  SCRUB_PAID: z.coerce.boolean().default(true),
});
