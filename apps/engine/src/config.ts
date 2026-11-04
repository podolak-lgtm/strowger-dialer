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
  TELNYX_API_URL: z.string().default("https://api.telnyx.com/v2"),
  /** Where Telnyx sends inbound calls: the jambonz SBC. Default = the account's SIP realm, which on jambonz.cloud resolves to the SBC. */
  JAMBONZ_SBC_FQDN: z.string().optional(),
  /** AI read of inbound text replies (opt-out intent, callback requests). Unset = keyword matching only. */
  ANTHROPIC_API_KEY: z.string().optional(),
  SMS_AI_MODEL: z.string().default("claude-opus-5-5"),
  /** Below this confidence an AI-detected opt-out is flagged for review, not applied. */
  SMS_AI_OPT_OUT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),

  // Crossbar scrub (optional). Without both, leads are marked CLEAN with the reason "No scrub source configured".
  CROSSBAR_URL: z.string().optional(),
  CROSSBAR_AGENT_KEY: z.string().optional(),
  /** Run the paid SubscriberVerify layer, not only Crossbar's own lists. */
  SCRUB_PAID: z.coerce.boolean().default(true),

  /** Screener detection needs an STT vendor configured on the jambonz account (deepgram, google, …). Unset = detection off. */
  SCREENER_STT_VENDOR: z.string().optional(),
  SCREENER_STT_LANGUAGE: z.string().default("en-US"),

  // Media bucket (voicemail recordings). Same bucket the web app serves prompts from.
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});
