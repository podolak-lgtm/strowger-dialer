// External transfers (owner, 5 Nov): the pure rules. The engine's
// dialer/transfers.ts drives jambonz with these; the console and the campaign
// page read the same constants so every screen says the same thing.
import { renderTemplate } from "./cadence";

/** Seconds the destination rings before a cold or warm transfer gives up. */
export const TRANSFER_RING_SECONDS = 25;
/** Minutes a lead and a destination may stay connected after the agent has left. */
export const TRANSFER_CAP_MINUTES = 90;
/** Disposition written when the agent leaves a transferred call (created on the campaign if missing). */
export const TRANSFER_DISPOSITION = { code: "XFER", label: "Transferred" } as const;

export const DEFAULT_WHISPER = "Transfer from {{company}}, {{campaign}}. Lead {{lead.firstName}} {{lead.lastName}}.";

/** Every variable a whisper template may use, with the console's script names as aliases. */
export const WHISPER_VARIABLES = ["company", "campaign", "destination", "agent", "lead.firstName", "lead.lastName", "lead.phone", "lead.city", "lead.state", "first_name", "last_name", "city", "state"] as const;

export interface WhisperContext {
  company: string;
  campaign: string;
  destination: string;
  agent?: string | null;
  lead: { firstName?: string | null; lastName?: string | null; phone?: string | null; city?: string | null; state?: string | null } | null;
}

/** The variables for `renderTemplate`, both spellings. */
export function whisperVars(ctx: WhisperContext): Record<string, string> {
  const l = ctx.lead ?? {};
  return {
    company: ctx.company,
    campaign: ctx.campaign,
    destination: ctx.destination,
    agent: ctx.agent ?? "",
    "lead.firstName": l.firstName ?? "",
    "lead.lastName": l.lastName ?? "",
    "lead.phone": l.phone ?? "",
    "lead.city": l.city ?? "",
    "lead.state": l.state ?? "",
    first_name: l.firstName ?? "",
    last_name: l.lastName ?? "",
    city: l.city ?? "",
    state: l.state ?? "",
  };
}

/** The whisper the destination hears, with doubled spaces from empty names collapsed. */
export function renderWhisper(template: string | null | undefined, ctx: WhisperContext): string {
  return renderTemplate(template?.trim() || DEFAULT_WHISPER, whisperVars(ctx))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
}

export type TransferCallerIdMode = "CUSTOMER" | "STATIC";

export interface CallerIdChoice {
  /** Ten digits: what the destination's phone will show. */
  phone: string;
  /** Why: the lead's own number, a fixed number of ours, or the fallback. */
  source: "customer" | "static" | "fallback";
}

/**
 * What the destination sees as the caller. CUSTOMER = the lead's own number
 * (owner: "definitely show the customer's number whenever possible"); STATIC =
 * the destination's fixed number when it is still one of ours; otherwise the
 * campaign's caller ID that dialled the lead.
 */
export function chooseTransferCallerId(input: { mode: TransferCallerIdMode; leadPhone: string | null; staticCallerId: string | null; ownedNumbers: string[]; campaignCallerId: string | null }): CallerIdChoice | null {
  const ten = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  if (input.mode === "CUSTOMER" && ten(input.leadPhone).length === 10) return { phone: ten(input.leadPhone), source: "customer" };
  if (input.mode === "STATIC" && input.staticCallerId && input.ownedNumbers.map(ten).includes(ten(input.staticCallerId))) return { phone: ten(input.staticCallerId), source: "static" };
  if (ten(input.campaignCallerId).length === 10) return { phone: ten(input.campaignCallerId), source: "fallback" };
  return null;
}

/** The final outcome of a destination leg that ended before it was answered. */
export function unansweredOutcome(status: string, cancelled: boolean): "NO_ANSWER" | "CANCELLED" | "FAILED" {
  if (cancelled) return "CANCELLED";
  if (status === "failed") return "FAILED";
  return "NO_ANSWER";
}

/** E.164 for a stored destination number (ten digits or already +-prefixed). */
export function destinationE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
