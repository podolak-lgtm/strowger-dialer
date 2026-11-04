// Carrier reputation for our outbound numbers.
//
// The data comes from a reputation vendor (Caller ID Reputation, Numeracle,
// TNS, Hiya, …). Until the owner picks one, the `manual` provider is the
// only one wired: it records what a human checked. Adding a vendor means
// implementing `ReputationProvider` and selecting it by DID_REPUTATION_VENDOR.
import { prisma, type CarrierVerdict } from "@strowger/db";

export interface Reading {
  att: CarrierVerdict;
  verizon: CarrierVerdict;
  tmobile: CarrierVerdict;
  attestation: string | null;
  raw?: unknown;
}

export interface ReputationProvider {
  name: string;
  /** Check a batch of ten-digit numbers. Missing entries mean "no answer". */
  check(phones: string[]): Promise<Map<string, Reading>>;
}

/** Placeholder until a vendor is chosen: reports nothing, so verdicts stay UNKNOWN. */
const manual: ReputationProvider = {
  name: "manual",
  async check() {
    return new Map();
  },
};

export function provider(): ReputationProvider {
  const vendor = process.env.DID_REPUTATION_VENDOR ?? "manual";
  switch (vendor) {
    default:
      return manual;
  }
}

/** Run a check on these numbers and write the result to the pool and the scan log. */
export async function scanNumbers(tenantId: string, numberIds: string[]): Promise<{ scanned: number; answered: number }> {
  const numbers = await prisma.callerIdNumber.findMany({ where: { tenantId, id: { in: numberIds } } });
  const p = provider();
  const readings = await p.check(numbers.map((n) => n.phone));
  let answered = 0;
  for (const n of numbers) {
    const r = readings.get(n.phone);
    if (!r) continue;
    answered++;
    await recordReading(n.id, p.name, r);
  }
  return { scanned: numbers.length, answered };
}

export async function recordReading(numberId: string, vendor: string, r: Reading): Promise<void> {
  await prisma.$transaction([
    prisma.didScan.create({ data: { numberId, vendor, attVerdict: r.att, verizonVerdict: r.verizon, tmobileVerdict: r.tmobile, attestation: r.attestation, raw: (r.raw ?? null) as never } }),
    prisma.callerIdNumber.update({
      where: { id: numberId },
      data: {
        attVerdict: r.att,
        verizonVerdict: r.verizon,
        tmobileVerdict: r.tmobile,
        attestation: r.attestation,
        lastScannedAt: new Date(),
        // A number blocked or marked spam anywhere comes out of rotation on its own and rests three weeks.
        ...([r.att, r.verizon, r.tmobile].some((v) => v === "SPAM" || v === "BLOCKED") ? { status: "SPAM_FLAGGED" as const, restUntil: new Date(Date.now() + 21 * 86_400_000) } : {}),
      },
    }),
  ]);
}

export function worst(...v: CarrierVerdict[]): CarrierVerdict {
  const rank: CarrierVerdict[] = ["BLOCKED", "SPAM", "FLAGGED", "UNKNOWN", "GOOD"];
  return v.slice().sort((a, b) => rank.indexOf(a) - rank.indexOf(b))[0] ?? "UNKNOWN";
}

/** Carriers disagree: at least one says good and at least one says spam/blocked/flagged. */
export function discrepant(a: CarrierVerdict, b: CarrierVerdict, c: CarrierVerdict): boolean {
  const vs = [a, b, c];
  return vs.includes("GOOD") && vs.some((v) => v === "SPAM" || v === "BLOCKED" || v === "FLAGGED");
}
