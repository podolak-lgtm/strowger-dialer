import { prisma } from "@strowger/db";
import { tenDlcStage } from "@strowger/shared/tendlc";
import type { Session } from "@/lib/auth";

/**
 * A section's short status line, shown above its tab bar on every tab, so
 * nothing important hides behind a tab (owner, 7 Nov). `marks` adds a sign to
 * a tab's label (Carrier setup ✓). Only sections listed here have one.
 */
export type SectionStatus = { line: Array<{ text: string; tone?: "ok" | "warn" | "bad" }>; marks: Record<string, string> };

/** Numbers: counts and the two one-time setups, from the database only (no engine call on every tab). */
async function numbersStatus(s: Session): Promise<SectionStatus> {
  const t = s.tenant;
  const [total, inPool, pending] = await Promise.all([
    prisma.callerIdNumber.count({ where: { tenantId: t.id, status: { not: "RETIRED" } } }),
    prisma.callerIdNumber.count({ where: { tenantId: t.id, status: { not: "RETIRED" }, campaignId: null } }),
    prisma.numberOrder.count({ where: { tenantId: t.id, status: "pending" } }),
  ]);
  const carrierReady = Boolean(t.telnyxConnectionId && t.jambonzCarrierSid && t.telnyxMessagingProfileId);
  const ten = tenDlcStage(t.tenDlcBrand as Record<string, unknown> | null, t.tenDlcCampaign as Record<string, unknown> | null);
  const line: SectionStatus["line"] = [{ text: `${total} number${total === 1 ? "" : "s"} (${inPool} in the pool)` }];
  if (pending) line.push({ text: `${pending} order${pending === 1 ? "" : "s"} pending`, tone: "warn" });
  line.push({ text: ten.label, tone: ten.stage === "registered" ? "ok" : ten.stage === "failed" ? "bad" : "warn" });
  line.push(carrierReady ? { text: "carrier ready", tone: "ok" } : { text: "carrier not set up", tone: "warn" });
  return { line, marks: carrierReady ? { carrier: "✓" } : {} };
}

const STATUS: Record<string, { tab: string; load: (s: Session) => Promise<SectionStatus> }> = {
  // Shown to whoever may open the inventory tab (not to agents who only see Voicemails).
  numbers: { tab: "numbers", load: numbersStatus },
};

export async function sectionStatus(section: string, s: Session, visibleTabKeys: string[]): Promise<SectionStatus | null> {
  const entry = STATUS[section];
  if (!entry || !visibleTabKeys.includes(entry.tab)) return null;
  return entry.load(s);
}

export function SectionStatusLine({ status }: { status: SectionStatus }) {
  const tone = { ok: "text-emerald-400", warn: "text-amber-400", bad: "text-red-400" } as const;
  return (
    <p data-section-status className="-mt-2 mb-2 flex flex-wrap gap-x-2 text-xs text-zinc-500">
      {status.line.map((p, i) => (
        <span key={p.text} className={p.tone ? tone[p.tone] : undefined}>
          {i > 0 ? <span className="mr-2 text-zinc-600">·</span> : null}
          {p.text}
        </span>
      ))}
    </p>
  );
}
