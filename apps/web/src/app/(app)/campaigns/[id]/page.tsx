import { transcriptionReadiness } from "@/lib/assist-readiness";
import { prisma } from "@strowger/db";
import { campaignTab, type CampaignDraft } from "@strowger/shared/campaign-draft";
import { CAMPAIGN_SETTING_KEYS, rebuttalsText } from "@strowger/shared/campaign-form";
import { daysLeft, runIsLive } from "@strowger/shared/games";
import { SCRIPT_TEMPLATES, rebuttalLines } from "@strowger/shared/scripts";
import { notFound } from "next/navigation";
import { requireClientWorkspace } from "@/lib/auth";
import { CampaignEditor, type EditorProps } from "./editor";

// Campaign detail: tabs, one draft, one Save (editor.tsx). This server page
// only loads: the snapshot the draft starts from and what the tabs show
// read-only (list counts, webhook delivery state, script history, runs).
export default async function CampaignPage({ params, searchParams }: PageProps<"/campaigns/[id]">) {
  const s = await requireClientWorkspace("SUPERVISOR");
  const { id } = await params;
  const { games: gamesError, tab } = await searchParams;
  const c = await prisma.campaign.findFirst({
    where: { id, tenantId: s.tenant.id },
    include: {
      lists: { select: { id: true }, orderBy: { priority: "asc" } },
      dialPlans: { orderBy: [{ ageFromDays: "asc" }, { leadType: "asc" }] },
      dispositions: { orderBy: { sortOrder: "asc" } },
      webhooks: { include: { deliveries: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { createdAt: "asc" } },
      scripts: { orderBy: { version: "desc" }, take: 20, select: { version: true, body: true, createdAt: true } },
      pokerRuns: { orderBy: { createdAt: "desc" }, take: 6 },
      transferDestinations: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      _count: { select: { agents: true, scripts: true } },
    },
  });
  if (!c) notFound();
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [ownNumbers, otherCampaigns, tenantLists, ledger, pinned] = await Promise.all([
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id, status: "ACTIVE" }, select: { phone: true }, orderBy: { phone: "asc" } }),
    prisma.campaign.findMany({
      where: { tenantId: s.tenant.id, id: { not: c.id }, transferDestinations: { some: { active: true } } },
      select: { id: true, name: true, transferDestinations: { where: { active: true }, orderBy: { sortOrder: "asc" } } },
      orderBy: { name: "asc" },
    }),
    prisma.list.findMany({
      where: { tenantId: s.tenant.id },
      select: { id: true, name: true, priority: true, totalLeads: true, dialableLeads: true, status: true, campaignId: true, campaign: { select: { name: true } } },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      take: 1000,
    }),
    prisma.abandonLedger.aggregate({ where: { campaignId: c.id, day: { gte: since } }, _sum: { answered: true, abandoned: true } }),
    prisma.callerIdNumber.findMany({ where: { tenantId: s.tenant.id, campaignId: c.id, status: { not: "RETIRED" } }, select: { id: true, phone: true, areaCode: true, status: true, restUntil: true, registeredAt: true, provisionStatus: true }, orderBy: [{ areaCode: "asc" }, { phone: "asc" }] }),
  ]);
  const answered30 = ledger._sum.answered ?? 0;
  const abandoned30 = ledger._sum.abandoned ?? 0;
  const abandonRate = answered30 ? (abandoned30 / answered30) * 100 : 0;

  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  // Phrase lists (String[]) are edited one per line.
  const settings = Object.fromEntries(CAMPAIGN_SETTING_KEYS.map((k) => [k, typeof c[k] === "boolean" ? c[k] : Array.isArray(c[k]) ? (c[k] as string[]).join("\n") : str(c[k])])) as CampaignDraft["settings"];
  const sttReady = await transcriptionReadiness();
  const snapshot: CampaignDraft = {
    settings,
    lists: c.lists.map((l) => l.id),
    dialPlans: c.dialPlans.map((p) => ({ key: p.id, id: p.id, leadType: p.leadType ?? "", ageFromDays: str(p.ageFromDays), ageToDays: str(p.ageToDays), attemptsPerDay: str(p.attemptsPerDay), retryGapMinutes: str(p.retryGapMinutes), weight: str(p.weight) })),
    dispositions: c.dispositions.map((d) => ({ key: d.id, id: d.id, code: d.code, label: d.label, hotkey: d.hotkey ?? "", isContact: d.isContact, isSale: d.isSale, isCallback: d.isCallback, isDnc: d.isDnc, recycleAfterMinutes: str(d.recycleAfterMinutes), active: d.active })),
    transfers: c.transferDestinations.map((d) => ({ key: d.id, id: d.id, name: d.name, phone: d.phone, type: d.type, callerIdMode: d.callerIdMode, staticCallerId: d.staticCallerId ?? "", whisperOn: d.whisperOn, whisperText: d.whisperText ?? "", active: d.active })),
    webhooks: c.webhooks.map((w) => ({ key: w.id, id: w.id, url: w.url, events: w.events, active: w.active })),
    script: c.scripts[0]?.body ?? "",
    rebuttals: rebuttalsText(c.rebuttals),
    bets: { betsEnabled: c.betsEnabled, weeklyPoints: str(c.weeklyPoints), maxStake: str(c.maxStake) },
  };

  const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const props: EditorProps = {
    campaignId: c.id,
    header: {
      name: c.name,
      status: c.status,
      mode: c.dialMode === "RATIO" ? `Ratio ${c.ratio.toString()}:1` : "Preview",
      agents: c._count.agents,
      abandon: { text: `${abandonRate.toFixed(2)}% (${abandoned30}/${answered30})`, tone: abandonRate >= Number(c.abandonCapPct) ? "red" : abandonRate >= Number(c.abandonWarnPct) ? "amber" : "green" },
    },
    snapshot,
    sttReady,
    initialTab: campaignTab(tab),
    lists: tenantLists.map((l) => ({ id: l.id, name: l.name, priority: l.priority, totalLeads: l.totalLeads, dialableLeads: l.dialableLeads, status: l.status, elsewhere: l.campaignId && l.campaignId !== c.id ? (l.campaign?.name ?? "another campaign") : null })),
    webhookInfo: Object.fromEntries(c.webhooks.map((w) => [w.id, { secretPrefix: w.secret.slice(0, 12), last: w.deliveries[0] ? { status: w.deliveries[0].status, error: w.deliveries[0].lastError } : null }])),
    ownNumbers: ownNumbers.map((n) => n.phone),
    pinned: pinned.map((n) => ({ id: n.id, phone: n.phone, areaCode: n.areaCode, status: n.status, restUntil: n.restUntil && n.restUntil > now ? n.restUntil.toISOString().slice(0, 10) : null, registered: Boolean(n.registeredAt), provisionStatus: n.provisionStatus })),
    copySources: otherCampaigns.map((o) => ({
      id: o.id,
      name: o.name,
      destinations: o.transferDestinations.map((d) => ({ name: d.name, phone: d.phone, type: d.type, callerIdMode: d.callerIdMode, staticCallerId: d.staticCallerId ?? "", whisperOn: d.whisperOn, whisperText: d.whisperText ?? "", active: true })),
    })),
    scriptOptions: SCRIPT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, text: t.body })),
    rebuttalOptions: SCRIPT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, text: rebuttalLines(t) })),
    rebuttalPlaceholder: SCRIPT_TEMPLATES[0] ? rebuttalLines(SCRIPT_TEMPLATES[0]) : "",
    versions: c.scripts.map((v) => ({ version: v.version, body: v.body, createdAt: v.createdAt.toISOString().slice(0, 16).replace("T", " ") + " UTC" })),
    versionCount: c._count.scripts,
    runs: c.pokerRuns.map((r) => {
      const w = r.winningHand as { name: string; hand: string; cards: string[] } | null;
      const live = runIsLive(r, now);
      return {
        id: r.id,
        name: r.name,
        prize: r.prize,
        status: r.status,
        qualifies: r.qualifies,
        outcomesPerCard: r.outcomesPerCard,
        qualifyingCodes: r.qualifyingCodes,
        window: `${r.startsAt.toUTCString().slice(0, 16)} → ${r.endsAt.toUTCString().slice(0, 16)}`,
        live,
        liveLabel: live ? `${daysLeft(r.endsAt, now)} days left` : r.startsAt > now ? "starts later" : "past its end",
        endedAt: r.endedAt ? r.endedAt.toUTCString().slice(5, 16) : null,
        winner: w,
      };
    }),
    gamesError: typeof gamesError === "string" ? gamesError : undefined,
    runDefaults: { startsAt: localInput(now), endsAt: localInput(new Date(now.getTime() + 7 * 86_400_000)) },
  };
  return <CampaignEditor {...props} />;
}
