// jambonz REST (carriers, gateways, phone numbers). The @jambonz/sdk client
// covers calls/conferences/queues only, so these are plain fetches against
// the same API (routes as in jambonz/jambonz-api-server).
import { config } from "../config";

export class JambonzAdminError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!config.JAMBONZ_API_KEY) throw new JambonzAdminError("JAMBONZ_API_KEY is not set", 0);
  const res = await fetch(config.JAMBONZ_API_URL.replace(/\/+$/, "") + "/v1" + path, {
    method,
    headers: { authorization: `Bearer ${config.JAMBONZ_API_KEY}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new JambonzAdminError(`jambonz ${method} ${path}: ${res.status} ${text.slice(0, 200)}`, res.status);
  return (text ? JSON.parse(text) : null) as T;
}

const acct = () => config.JAMBONZ_ACCOUNT_SID ?? "";

export interface Carrier {
  voip_carrier_sid: string;
  name: string;
  is_active: number;
  register_username?: string | null;
  application_sid?: string | null;
}
export interface Gateway {
  sip_gateway_sid: string;
  voip_carrier_sid: string;
  ipv4: string;
  port: number;
  netmask: number;
  inbound: number;
  outbound: number;
  is_active: number;
}
export interface JzNumber {
  phone_number_sid: string;
  number: string;
  voip_carrier_sid: string | null;
  account_sid: string | null;
  application_sid: string | null;
}

/** A speech service on the account. The API also returns the decrypted keys: only these fields are ever kept. */
export interface SpeechCredentialRow {
  vendor: string;
  label?: string | null;
  use_for_stt?: number | boolean;
  use_for_tts?: number | boolean;
}

export const jambonzAdmin = {
  /** Speech services (STT/TTS) on the account and its service provider; keys are dropped here, never logged or returned. */
  listSpeechCredentials: async () =>
    (await call<SpeechCredentialRow[]>("GET", `/Accounts/${acct()}/SpeechCredentials`)).map((c) => ({ vendor: String(c.vendor), label: c.label ?? null, stt: Boolean(c.use_for_stt), tts: Boolean(c.use_for_tts) })),
  listCarriers: () => call<Carrier[]>("GET", `/Accounts/${acct()}/VoipCarriers`),
  createCarrier: async (c: { name: string; register_username?: string; register_password?: string }) => {
    const r = await call<{ sid: string }>("POST", "/VoipCarriers", {
      name: c.name,
      account_sid: acct(),
      is_active: 1,
      requires_register: 0,
      register_username: c.register_username ?? null,
      register_password: c.register_password ?? null,
      e164_leading_plus: 1,
    });
    return r.sid;
  },
  updateCarrier: (sid: string, patch: Record<string, unknown>) => call("PUT", `/VoipCarriers/${sid}`, patch),
  listGateways: (carrierSid: string) => call<Gateway[]>("GET", `/SipGateways?voip_carrier_sid=${carrierSid}`),
  createGateway: async (g: { voip_carrier_sid: string; ipv4: string; port?: number; inbound: boolean; outbound: boolean }) => {
    const r = await call<{ sid: string }>("POST", "/SipGateways", {
      voip_carrier_sid: g.voip_carrier_sid,
      ipv4: g.ipv4,
      port: g.port ?? 5060,
      netmask: 32,
      inbound: g.inbound ? 1 : 0,
      outbound: g.outbound ? 1 : 0,
      is_active: 1,
      protocol: "udp",
    });
    return r.sid;
  },
  listNumbers: () => call<JzNumber[]>("GET", `/Accounts/${acct()}/PhoneNumbers`),
  addNumber: async (number: string, carrierSid: string, applicationSid: string | null) => {
    const r = await call<{ sid: string }>("POST", "/PhoneNumbers", { number, voip_carrier_sid: carrierSid, account_sid: acct(), application_sid: applicationSid });
    return r.sid;
  },
  setNumberApplication: (sid: string, applicationSid: string | null) => call("PUT", `/PhoneNumbers/${sid}`, { application_sid: applicationSid }),
  deleteNumber: (sid: string) => call("DELETE", `/PhoneNumbers/${sid}`),
};
