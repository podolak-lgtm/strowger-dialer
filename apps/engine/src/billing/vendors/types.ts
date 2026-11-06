// The common shape of a vendor connector (owner, 6 Nov: "a button next to it I
// can click: you log in, find it and download whatever you need"). A connector
// only reads: it returns what it found, and the runner (./index.ts) writes it
// through the one cost model (keepUsage, VendorAccount, VendorInvoice).

export interface CredentialField {
  key: string;
  label: string;
  /** Sealed at rest and never shown again (only "saved, ending …1234"). */
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  /** Engine env var used when nothing is saved for this field. */
  env?: string;
}

/** A running month total from the vendor's API or portal; written as period:<YYYY-MM>:<part>, source api. */
export interface PeriodRow {
  period: string;
  part: string;
  kind: string;
  millicents: number;
  quantity?: number;
  label?: string;
  tenantId?: string | null;
}

export interface InvoiceLine {
  description: string;
  quantity: number | null;
  /** Dollars, as printed (negative for credits). */
  amount: number;
}

/** An invoice found by a connector. With `file` and no `lines`, the runner has Claude read the file. */
export interface FoundInvoice {
  invoiceNumber?: string | null;
  period?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalCents?: number | null;
  currency?: string | null;
  lines?: InvoiceLine[];
  file?: { bytes: Buffer; type: "pdf" | "csv" };
}

export interface CollectResult {
  /** Prepaid balance or credit left, in cents. */
  balanceCents?: number | null;
  /** The vendor's own figure for a month (reconciliation, shown beside ours). */
  reported?: { period: string; cents: number } | null;
  /** Months whose period rows this run is the full picture of (rows for the month not returned again are removed). */
  periods?: string[];
  rows?: PeriodRow[];
  invoices?: FoundInvoice[];
  /** One line for the Balances table (plan name, credits used…). */
  note?: string | null;
}

export type Step = (state: string, line: string) => Promise<void>;

export interface CollectContext {
  now: Date;
  /** Saved credentials, with env fallbacks filled in. */
  creds: Record<string, string>;
  step: Step;
  /** Set by browser connectors on failure: the screenshot's bucket key. */
  screenshot?: (key: string) => void;
}

export interface Connector {
  vendor: string;
  label: string;
  method: "api" | "browser" | "api+browser";
  /** What a run collects, in a sentence, for the card. */
  collects: string;
  /** Where the owner gets the credential, in a sentence. */
  whereToGet: string;
  credentials: CredentialField[];
  /** Null when it can run; else why not ("Enter the API token"). */
  missing: (creds: Record<string, string>) => string | null;
  collect: (ctx: CollectContext) => Promise<CollectResult>;
}

/** A step a person has to do (a CAPTCHA, an unsupported second factor): the run stops and says so. */
export class NeedsPerson extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsPerson";
  }
}

export const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export const periodOf = (d: Date) => d.toISOString().slice(0, 7);
export const prevMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
