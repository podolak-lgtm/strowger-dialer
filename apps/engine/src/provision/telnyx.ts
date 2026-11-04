// Thin Telnyx v2 REST wrapper for provisioning. Shapes follow Telnyx's
// published OpenAPI spec (team-telnyx/openapi, 2026-05).
import { config } from "../config";

export const telnyxConfigured = Boolean(config.TELNYX_API_KEY);

export class TelnyxError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
  if (!config.TELNYX_API_KEY) throw new TelnyxError("TELNYX_API_KEY is not set on the engine", 0, null);
  const u = new URL(config.TELNYX_API_URL.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    method,
    headers: { authorization: `Bearer ${config.TELNYX_API_KEY}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const errs = (json as { errors?: { title?: string; detail?: string }[] })?.errors;
    const msg = errs?.map((e) => [e.title, e.detail].filter(Boolean).join(": ")).join("; ") || `${res.status} ${res.statusText}`;
    throw new TelnyxError(`Telnyx ${method} ${path}: ${msg}`, res.status, json);
  }
  return json as T;
}

type Wrapped<T> = { data: T };
type Page<T> = { data: T[]; meta?: { total_pages?: number; page_number?: number } };

export interface AvailableNumber {
  phone_number: string;
  region_information?: { region_type: string; region_name: string }[];
  cost_information?: { upfront_cost: string; monthly_cost: string; currency: string };
  features?: { name: string }[];
  best_effort?: boolean;
}
export interface TelnyxNumber {
  id: string;
  phone_number: string;
  status: string;
  connection_id: string | null;
  connection_name?: string | null;
  messaging_profile_id: string | null;
  messaging_campaign_id?: string | null;
  phone_number_type?: string;
  purchased_at?: string;
}
export interface NumberOrderResult {
  id: string;
  status: "pending" | "success" | "failure";
  phone_numbers: { id: string; phone_number: string; status: "pending" | "success" | "failure"; requirements_met?: boolean }[];
}

export const telnyx = {
  // --- numbers
  async searchNumbers(q: { areaCode?: string; state?: string; locality?: string; limit?: number; features?: string[] }): Promise<AvailableNumber[]> {
    const query: Record<string, string | number | undefined> = {
      "filter[country_code]": "US",
      "filter[phone_number_type]": "local",
      "filter[limit]": q.limit ?? 20,
      "filter[best_effort]": "false",
    };
    if (q.areaCode) query["filter[national_destination_code]"] = q.areaCode;
    if (q.state) query["filter[administrative_area]"] = q.state;
    if (q.locality) query["filter[locality]"] = q.locality;
    // features[] repeats; build by hand
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.set(k, String(v));
    for (const f of q.features ?? ["voice", "sms"]) u.append("filter[features][]", f);
    const r = await call<Page<AvailableNumber>>("GET", `/available_phone_numbers?${u.toString()}`);
    return r.data;
  },
  async order(phoneNumbers: string[], connectionId?: string | null, messagingProfileId?: string | null, reference?: string): Promise<NumberOrderResult> {
    const r = await call<Wrapped<NumberOrderResult>>("POST", "/number_orders", {
      phone_numbers: phoneNumbers.map((phone_number) => ({ phone_number })),
      connection_id: connectionId ?? undefined,
      messaging_profile_id: messagingProfileId ?? undefined,
      customer_reference: reference,
    });
    return r.data;
  },
  async getOrder(id: string): Promise<NumberOrderResult> {
    return (await call<Wrapped<NumberOrderResult>>("GET", `/number_orders/${id}`)).data;
  },
  async listNumbers(): Promise<TelnyxNumber[]> {
    const out: TelnyxNumber[] = [];
    for (let page = 1; page < 50; page++) {
      const r = await call<Page<TelnyxNumber>>("GET", "/phone_numbers", undefined, { "page[size]": 250, "page[number]": page });
      out.push(...r.data);
      if (!r.meta?.total_pages || page >= r.meta.total_pages) break;
    }
    return out;
  },
  async findNumber(e164: string): Promise<TelnyxNumber | null> {
    const r = await call<Page<TelnyxNumber>>("GET", "/phone_numbers", undefined, { "filter[phone_number]": e164, "page[size]": 5 });
    return r.data.find((n) => n.phone_number === e164) ?? null;
  },
  async setNumberConnection(id: string, connectionId: string): Promise<void> {
    await call("PATCH", `/phone_numbers/${id}`, { connection_id: connectionId });
  },
  async setNumberMessagingProfile(id: string, messagingProfileId: string): Promise<void> {
    await call("PATCH", `/phone_numbers/${id}/messaging`, { messaging_profile_id: messagingProfileId });
  },
  async releaseNumber(id: string): Promise<void> {
    await call("DELETE", `/phone_numbers/${id}`);
  },

  // --- voice
  async listOutboundProfiles(): Promise<{ id: string; name: string }[]> {
    return (await call<Page<{ id: string; name: string }>>("GET", "/outbound_voice_profiles", undefined, { "page[size]": 100 })).data;
  },
  async createOutboundProfile(name: string): Promise<{ id: string; name: string }> {
    return (await call<Wrapped<{ id: string; name: string }>>("POST", "/outbound_voice_profiles", { name, traffic_type: "conversational", whitelisted_destinations: ["US", "CA"] })).data;
  },
  async listFqdnConnections(): Promise<{ id: string; connection_name: string; user_name?: string; password?: string }[]> {
    return (await call<Page<{ id: string; connection_name: string; user_name?: string; password?: string }>>("GET", "/fqdn_connections", undefined, { "page[size]": 100 })).data;
  },
  async createFqdnConnection(name: string, outboundProfileId: string): Promise<{ id: string; connection_name: string; user_name?: string; password?: string }> {
    return (
      await call<Wrapped<{ id: string; connection_name: string; user_name?: string; password?: string }>>("POST", "/fqdn_connections", {
        connection_name: name,
        active: true,
        transport_protocol: "UDP",
        inbound: { ani_number_format: "+E.164", dnis_number_format: "+e164", codecs: ["G722", "G711U", "G711A", "OPUS"], default_routing_method: "sequential", sip_region: "US" },
        outbound: { ip_authentication_method: "credential-authentication", outbound_voice_profile_id: outboundProfileId, localization: "US" },
      })
    ).data;
  },
  async getFqdnConnection(id: string): Promise<{ id: string; connection_name: string; user_name?: string; password?: string; inbound?: { default_primary_fqdn_id?: string | null } }> {
    return (await call<Wrapped<{ id: string; connection_name: string; user_name?: string; password?: string; inbound?: { default_primary_fqdn_id?: string | null } }>>("GET", `/fqdn_connections/${id}`)).data;
  },
  async listFqdns(connectionId: string): Promise<{ id: string; fqdn: string; port: number }[]> {
    return (await call<Page<{ id: string; fqdn: string; port: number }>>("GET", "/fqdns", undefined, { "filter[connection_id]": connectionId, "page[size]": 50 })).data;
  },
  async addFqdn(connectionId: string, fqdn: string, port = 5060): Promise<{ id: string; fqdn: string; port: number }> {
    return (await call<Wrapped<{ id: string; fqdn: string; port: number }>>("POST", "/fqdns", { connection_id: connectionId, fqdn, port, dns_record_type: "a" })).data;
  },
  async setPrimaryFqdn(connectionId: string, fqdnId: string): Promise<void> {
    await call("PATCH", `/fqdn_connections/${connectionId}`, { inbound: { default_primary_fqdn_id: fqdnId } });
  },

  // --- messaging
  async listMessagingProfiles(): Promise<{ id: string; name: string; webhook_url: string | null }[]> {
    return (await call<Page<{ id: string; name: string; webhook_url: string | null }>>("GET", "/messaging_profiles", undefined, { "page[size]": 100 })).data;
  },
  async createMessagingProfile(name: string, webhookUrl: string): Promise<{ id: string; name: string }> {
    return (await call<Wrapped<{ id: string; name: string }>>("POST", "/messaging_profiles", { name, whitelisted_destinations: ["US", "CA"], webhook_url: webhookUrl, webhook_api_version: "2", enabled: true })).data;
  },
  async updateMessagingProfileWebhook(id: string, webhookUrl: string): Promise<void> {
    await call("PATCH", `/messaging_profiles/${id}`, { webhook_url: webhookUrl, webhook_api_version: "2" });
  },

  // --- 10DLC (A2P registration through The Campaign Registry)
  async listBrands(): Promise<Brand[]> {
    return (await call<{ records: Brand[] }>("GET", "/10dlc/brand", undefined, { recordsPerPage: 50 })).records;
  },
  async getBrand(brandId: string): Promise<Brand> {
    return call<Brand>("GET", `/10dlc/brand/${brandId}`);
  },
  async createBrand(b: BrandInput): Promise<Brand> {
    return call<Brand>("POST", "/10dlc/brand", b);
  },
  async listCampaigns(brandId?: string): Promise<TenDlcCampaign[]> {
    return (await call<{ records: TenDlcCampaign[] }>("GET", "/10dlc/campaign", undefined, { brandId, recordsPerPage: 50 })).records;
  },
  async getCampaign(campaignId: string): Promise<TenDlcCampaign> {
    return call<TenDlcCampaign>("GET", `/10dlc/campaign/${campaignId}`);
  },
  async createCampaign(c: CampaignInput): Promise<TenDlcCampaign> {
    return call<TenDlcCampaign>("POST", "/10dlc/campaignBuilder", c);
  },
  async usecaseQualification(brandId: string, usecase: string): Promise<{ monthlyFee?: number; annualFee?: number; mnoMetadata?: unknown }> {
    return call("GET", `/10dlc/campaignBuilder/brand/${brandId}/usecase/${usecase}`);
  },
  async assignProfileToCampaign(messagingProfileId: string, campaignId: string): Promise<{ taskId: string }> {
    return call<{ taskId: string }>("POST", "/10dlc/phoneNumberAssignmentByProfile", { messagingProfileId, campaignId });
  },
  async assignmentTask(taskId: string): Promise<{ status: string }> {
    return call<{ status: string }>("GET", `/10dlc/phoneNumberAssignmentByProfile/${taskId}`);
  },
  async numberCampaign(e164: string): Promise<{ assignmentStatus?: string; campaignId?: string; failureReasons?: string } | null> {
    try {
      return await call("GET", `/10dlc/phone_number_campaigns/${encodeURIComponent(e164)}`);
    } catch (e) {
      if (e instanceof TelnyxError && e.status === 404) return null;
      throw e;
    }
  },
  async enumValues(endpoint: "usecase" | "vertical" | "entityType"): Promise<unknown> {
    return call("GET", `/10dlc/enum/${endpoint}`);
  },
};

export interface BrandInput {
  entityType: "PRIVATE_PROFIT" | "PUBLIC_PROFIT" | "NON_PROFIT" | "GOVERNMENT" | "SOLE_PROPRIETOR";
  displayName: string;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  ein?: string;
  phone?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: string;
  email: string;
  website?: string;
  vertical: string;
  stockSymbol?: string;
  stockExchange?: string;
  businessContactEmail?: string;
  mock?: boolean;
}
export interface Brand extends Partial<BrandInput> {
  brandId: string;
  tcrBrandId?: string;
  identityStatus?: string;
  status?: string;
  failureReasons?: string;
  createdAt?: string;
  assignedCampaignsCount?: number;
}
export interface CampaignInput {
  brandId: string;
  usecase: string;
  subUsecases?: string[];
  description?: string;
  messageFlow: string;
  sample1: string;
  sample2?: string;
  sample3?: string;
  sample4?: string;
  sample5?: string;
  subscriberOptin: boolean;
  subscriberOptout: boolean;
  subscriberHelp: boolean;
  optinKeywords?: string;
  optoutKeywords?: string;
  helpKeywords?: string;
  optinMessage?: string;
  optoutMessage?: string;
  helpMessage?: string;
  embeddedLink: boolean;
  embeddedPhone: boolean;
  numberPool: boolean;
  ageGated: boolean;
  directLending: boolean;
  autoRenewal: boolean;
  termsAndConditions: boolean;
  privacyPolicyLink?: string;
  termsAndConditionsLink?: string;
  embeddedLinkSample?: string;
}
export interface TenDlcCampaign extends Partial<CampaignInput> {
  campaignId: string;
  tcrCampaignId?: string;
  campaignStatus?: string;
  submissionStatus?: string;
  failureReasons?: string;
  createDate?: string;
  assignedPhoneNumbersCount?: number;
  isTMobileRegistered?: boolean;
}

/** Telnyx SIP signalling addresses (sip.telnyx.com/voice.json, 2026-05). jambonz needs them as inbound gateways. */
export const TELNYX_SIGNALLING_IPS = ["192.76.120.10", "64.16.250.10", "192.76.120.31", "64.16.250.13"];
export const TELNYX_SIP_HOST = "sip.telnyx.com";
