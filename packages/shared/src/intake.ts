// The shape of a lead on its way in, from an upload or a post, and the
// normalisation both paths share. The database never sees an un-normalised
// lead.
import { z } from "zod";
import { normalizePhone } from "./phone";

const optionalString = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined ? null : String(v).trim() || null));

/** Field names the posting API and the upload mapper both produce. */
export const LEAD_FIELDS = [
  "first_name",
  "last_name",
  "phone",
  "address",
  "city",
  "state",
  "zip",
  "email",
  "jornaya_lead_id",
  "trustedform_cert_url",
  "opt_in_url",
  "opt_in_at",
  "opt_in_ip",
  "lead_type",
] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export const LEAD_FIELD_LABELS: Record<LeadField, string> = {
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  address: "Street address",
  city: "City",
  state: "State",
  zip: "ZIP",
  email: "Email",
  jornaya_lead_id: "Jornaya LeadiD",
  trustedform_cert_url: "TrustedForm certificate",
  opt_in_url: "Opt-in URL",
  opt_in_at: "Opt-in timestamp",
  opt_in_ip: "Opt-in IP",
  lead_type: "Lead type",
};

/** Fields the posting API insists on. Uploads are looser: phone only. */
export const POST_REQUIRED_FIELDS: LeadField[] = ["first_name", "last_name", "phone", "address", "city", "state", "zip", "opt_in_url", "opt_in_at"];

export const LeadInputSchema = z
  .object({
    first_name: optionalString,
    last_name: optionalString,
    phone: z.union([z.string(), z.number()]).transform((v) => String(v)),
    address: optionalString,
    city: optionalString,
    state: optionalString.transform((v) => (v ? v.toUpperCase().slice(0, 2) : null)),
    zip: optionalString.transform((v) => {
      if (!v) return null;
      let digits = v.replace(/\D/g, "");
      // Spreadsheets drop leading zeros: 2101 is 02101.
      if (digits.length === 3 || digits.length === 4) digits = digits.padStart(5, "0");
      return digits.length >= 5 ? digits.slice(0, 5) : null;
    }),
    email: optionalString.transform((v) => (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v.toLowerCase() : null)),
    jornaya_lead_id: optionalString,
    trustedform_cert_url: optionalString,
    opt_in_url: optionalString,
    opt_in_at: optionalString.transform((v) => {
      if (!v) return null;
      const d = new Date(/^\d{10,13}$/.test(v) ? Number(v.length === 10 ? `${v}000` : v) : v);
      return Number.isNaN(d.getTime()) ? null : d;
    }),
    opt_in_ip: optionalString,
    lead_type: optionalString,
  })
  .passthrough();

export type LeadInput = z.input<typeof LeadInputSchema>;

export interface NormalizedLead {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  email: string | null;
  consentJornayaId: string | null;
  consentTrustedFormId: string | null;
  optInUrl: string | null;
  optInAt: Date | null;
  optInIp: string | null;
  leadType: string | null;
  /** Anything that was not a known field. */
  custom: Record<string, unknown>;
}

export type NormalizeResult =
  | { ok: true; lead: NormalizedLead }
  | { ok: false; reason: "bad_phone" | "invalid"; detail: string };

export function normalizeLead(raw: unknown): NormalizeResult {
  const parsed = LeadInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const d = parsed.data;
  const phone = normalizePhone(d.phone);
  if (!phone) return { ok: false, reason: "bad_phone", detail: `"${d.phone}" is not a dialable US number` };

  const known = new Set<string>(LEAD_FIELDS);
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!known.has(k)) custom[k] = v;

  return {
    ok: true,
    lead: {
      phone,
      firstName: d.first_name,
      lastName: d.last_name,
      address: d.address,
      city: d.city,
      state: d.state,
      zip: d.zip,
      email: d.email,
      consentJornayaId: d.jornaya_lead_id,
      consentTrustedFormId: d.trustedform_cert_url,
      optInUrl: d.opt_in_url,
      optInAt: d.opt_in_at,
      optInIp: d.opt_in_ip,
      leadType: d.lead_type,
      custom,
    },
  };
}

/** Which required posting fields are missing from a normalised lead. */
export function missingPostFields(lead: NormalizedLead): LeadField[] {
  const present: Record<LeadField, unknown> = {
    first_name: lead.firstName,
    last_name: lead.lastName,
    phone: lead.phone,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
    email: lead.email,
    jornaya_lead_id: lead.consentJornayaId,
    trustedform_cert_url: lead.consentTrustedFormId,
    opt_in_url: lead.optInUrl,
    opt_in_at: lead.optInAt,
    opt_in_ip: lead.optInIp,
    lead_type: lead.leadType,
  };
  return POST_REQUIRED_FIELDS.filter((f) => !present[f]);
}
