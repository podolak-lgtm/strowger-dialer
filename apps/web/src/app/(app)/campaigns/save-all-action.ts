"use server";

// The campaign page's one Save (owner's spec, 5 Nov): every tab's edits arrive
// as one draft and are written inside one transaction, so either all of it
// lands or none of it does. Validation is the per-section actions' own
// (@strowger/shared/campaign-form); errors come back keyed by tab and input so
// the page can jump to the first one. What stays immediate and never comes
// through here: Start/End the poker run, Deactivate a transfer destination,
// Test a webhook.
import { prisma, Prisma } from "@strowger/db";
import { dirtyTabs, type CampaignDraft, type CampaignTab, type DraftError, type RemovedIds } from "@strowger/shared/campaign-draft";
import { CAMPAIGN_SETTING_KEYS, FieldError, STATIC_CALLER_ID_NOT_OURS, fromRecord, parseDialPlan, parseDisposition, parseRebuttals, parseTransferDestination, parseWebhook, scriptBody } from "@strowger/shared/campaign-form";
import { betTopUps, clampBetSettings } from "@strowger/shared/games";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { canManageGames } from "@/lib/rights";
import { campaignSettingsData, newWebhookSecret, ownsActiveNumber, returnNumbersToPool } from "./campaign-data";

export type SaveAllResult = { ok: true; saved: CampaignTab[]; warning?: string } | { ok: false; errors: DraftError[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v: unknown) => (v instanceof Prisma.Decimal ? v.toNumber() : v);

export async function saveCampaignAll(campaignId: string, input: { snapshot: CampaignDraft; draft: CampaignDraft; removed: RemovedIds }): Promise<SaveAllResult> {
  const s = await requireRole("SUPERVISOR");
  const tenantId = s.tenant.id;
  const { draft, removed } = input;
  const before = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId },
    include: {
      lists: { select: { id: true } },
      dialPlans: true,
      dispositions: { include: { _count: { select: { calls: true } } } },
      transferDestinations: { include: { _count: { select: { transfers: true } } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      webhooks: true,
      scripts: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!before) return { ok: false, errors: [{ tab: "dialing", field: "settings.name", message: "This campaign no longer exists" }] };

  const errors: DraftError[] = [];
  const fail = (tab: CampaignTab, field: string, message: string) => errors.push({ tab, field, message });
  const field = (tab: CampaignTab, prefix: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof FieldError) fail(tab, `${prefix}.${e.field}`, e.message);
      else throw e;
    }
  };

  // ---- Campaign settings (Dialing, Compliance, Voicemail & screeners)
  const settings = campaignSettingsData(fromRecord(draft.settings), before);
  const settingsChanged = CAMPAIGN_SETTING_KEYS.filter((k) => !same(plain(before[k]), settings[k]));
  if (settings.name !== before.name) {
    const clash = await prisma.campaign.findFirst({ where: { tenantId, name: settings.name, id: { not: campaignId } }, select: { id: true } });
    if (clash) fail("dialing", "settings.name", "Another campaign already has this name");
  }

  // ---- Lists
  const attachedNow = new Set(before.lists.map((l) => l.id));
  const attach = [...new Set(draft.lists)].filter((id) => !attachedNow.has(id));
  const detach = removed.lists.filter((id) => attachedNow.has(id));
  if (attach.length) {
    const found = await prisma.list.count({ where: { id: { in: attach }, tenantId } });
    if (found !== attach.length) fail("lists", "lists", "A list picked to attach no longer exists");
  }

  // ---- Dial plans
  const planById = new Map(before.dialPlans.map((p) => [p.id, p]));
  const planWrites: { id: string | null; data: ReturnType<typeof parseDialPlan> }[] = [];
  for (const row of draft.dialPlans) {
    const data = parseDialPlan(fromRecord(row));
    const old = row.id ? planById.get(row.id) : undefined;
    if (row.id && !old) continue; // removed elsewhere since the page loaded
    const visible = (p: Omit<typeof data, "active">) => [p.leadType, p.ageFromDays, p.ageToDays, p.attemptsPerDay, p.retryGapMinutes, p.weight];
    if (old && same(visible(old), visible(data))) continue;
    planWrites.push({ id: row.id, data });
  }

  // ---- Dispositions
  const dispById = new Map(before.dispositions.map((d) => [d.id, d]));
  const dispWrites: { id: string | null; data: ReturnType<typeof parseDisposition> }[] = [];
  const codes = new Map<string, string>();
  for (const d of before.dispositions) if (removed.dispositions.includes(d.id) && d._count.calls > 0) codes.set(d.code, "kept");
  for (const row of draft.dispositions) {
    field("dispositions", `dispositions.${row.key}`, () => {
      const data = parseDisposition(fromRecord({ ...row, active: row.active ? "on" : "off" }));
      if (codes.has(data.code)) throw new FieldError("code", codes.get(data.code) === "kept" ? `${data.code} is still kept for call history (removed, not deleted); pick another code` : `Another disposition already uses ${data.code}`);
      codes.set(data.code, row.key);
      const old = row.id ? dispById.get(row.id) : undefined;
      if (row.id && !old) return;
      const keys = ["code", "label", "hotkey", "isContact", "isSale", "isDnc", "isCallback", "recycleAfterMinutes", "active"] as const;
      if (old && keys.every((k) => old[k] === data[k])) return;
      dispWrites.push({ id: row.id, data });
    });
  }

  // ---- Transfer destinations
  const destById = new Map(before.transferDestinations.map((d) => [d.id, d]));
  const destWrites: { key: string; id: string | null; data: ReturnType<typeof parseTransferDestination> }[] = [];
  for (const row of draft.transfers) {
    const old = row.id ? destById.get(row.id) : undefined;
    if (row.id && !old) continue;
    const prefix = `transfers.${row.key}`;
    let data: ReturnType<typeof parseTransferDestination> | null = null;
    field("transfers", prefix, () => {
      data = parseTransferDestination(fromRecord(row));
    });
    if (!data) continue;
    const d: ReturnType<typeof parseTransferDestination> = data;
    if (old && (["name", "phone", "type", "callerIdMode", "staticCallerId", "whisperOn", "whisperText"] as const).every((k) => old[k] === d[k])) continue;
    if (d.staticCallerId && !(await ownsActiveNumber(prisma, tenantId, d.staticCallerId))) fail("transfers", `${prefix}.staticCallerId`, STATIC_CALLER_ID_NOT_OURS);
    else destWrites.push({ key: row.key, id: row.id, data: d });
  }
  const keptDest = before.transferDestinations.filter((d) => !removed.transfers.includes(d.id) && !draft.transfers.some((r) => r.id === d.id));
  const orderChanged = !same(
    draft.transfers.filter((r) => r.id).map((r) => r.id),
    before.transferDestinations.filter((d) => draft.transfers.some((r) => r.id === d.id)).map((d) => d.id),
  );

  // ---- Webhooks
  const hookById = new Map(before.webhooks.map((w) => [w.id, w]));
  const hookWrites: { id: string | null; data: { url: string; events: string[]; active: boolean } }[] = [];
  for (const row of draft.webhooks) {
    const old = row.id ? hookById.get(row.id) : undefined;
    if (row.id && !old) continue;
    field("crm", `webhooks.${row.key}`, () => {
      const data = { ...parseWebhook(row.url, row.events), active: row.active };
      if (old && old.url === data.url && same([...old.events].sort(), [...data.events].sort()) && old.active === data.active) return;
      hookWrites.push({ id: row.id, data });
    });
  }

  // ---- Script (a new version only when the text changed) and rebuttals
  const body = scriptBody(draft.script);
  const lastScript = before.scripts[0] ?? null;
  const scriptChanged = (lastScript?.body ?? "") !== body;
  const rebuttals = parseRebuttals(draft.rebuttals);
  const rebuttalsChanged = !same((before.rebuttals as unknown[] | null) ?? [], rebuttals);

  // ---- Games: bets switch
  const bets = { betsEnabled: draft.bets.betsEnabled, ...clampBetSettings({ weeklyPoints: Number(draft.bets.weeklyPoints), maxStake: Number(draft.bets.maxStake) }) };
  const betsChanged = bets.betsEnabled !== before.betsEnabled || bets.weeklyPoints !== before.weeklyPoints || bets.maxStake !== before.maxStake;
  if (betsChanged && !canManageGames(s)) fail("games", "games.betsEnabled", "Only admins, supervisors, or team leaders with the Manage games right can change games");

  if (errors.length) return { ok: false, errors };

  // ---- Write it all, or nothing
  let credits: { userId: string; delta: number; reason: string }[] = [];
  const diff: Record<string, unknown> = {};
  try {
    await prisma.$transaction(
      async (tx) => {
        const campaignData: Prisma.CampaignUpdateInput = {};
        if (settingsChanged.length) {
          Object.assign(campaignData, settings);
          diff.settings = Object.fromEntries(settingsChanged.map((k) => [k, [plain(before[k]), settings[k]]]));
        }
        if (rebuttalsChanged) {
          campaignData.rebuttals = rebuttals;
          diff.rebuttals = { count: rebuttals.length };
        }
        if (betsChanged) {
          Object.assign(campaignData, bets);
          diff.bets = { before: { betsEnabled: before.betsEnabled, weeklyPoints: before.weeklyPoints, maxStake: before.maxStake }, after: bets };
        }
        if (Object.keys(campaignData).length) await tx.campaign.update({ where: { id: campaignId }, data: campaignData });
        // Archived: the campaign's numbers go back to the pool (the page said so in its confirm).
        if (settings.status === "ARCHIVED" && before.status !== "ARCHIVED") diff.numbersToPool = await returnNumbersToPool(tx, tenantId, campaignId);

        // A list belongs to one campaign at a time: attaching moves it here.
        if (attach.length) await tx.list.updateMany({ where: { id: { in: attach }, tenantId }, data: { campaignId } });
        if (detach.length) await tx.list.updateMany({ where: { id: { in: detach }, tenantId, campaignId }, data: { campaignId: null } });
        if (attach.length || detach.length) diff.lists = { attached: attach, detached: detach };

        if (removed.dialPlans.length) await tx.dialPlan.deleteMany({ where: { id: { in: removed.dialPlans }, campaignId, tenantId } });
        for (const w of planWrites) {
          if (w.id) await tx.dialPlan.update({ where: { id: w.id }, data: w.data });
          else await tx.dialPlan.create({ data: { tenantId, campaignId, ...w.data } });
        }
        if (removed.dialPlans.length || planWrites.length) diff.dialPlans = { removed: removed.dialPlans.length, written: planWrites.length };

        // Dispositions used by calls are switched off, never deleted.
        for (const id of removed.dispositions) {
          const d = dispById.get(id);
          if (!d) continue;
          if (d._count.calls > 0) await tx.disposition.update({ where: { id }, data: { active: false } });
          else await tx.disposition.delete({ where: { id } });
        }
        for (const w of dispWrites) if (w.id) await tx.disposition.update({ where: { id: w.id }, data: w.data });
        for (const w of dispWrites) if (!w.id) await tx.disposition.create({ data: { tenantId, campaignId, ...w.data, sortOrder: 99 } });
        if (removed.dispositions.length || dispWrites.length) diff.dispositions = { removed: removed.dispositions.length, written: dispWrites.map((w) => w.data.code) };

        // Destinations: a used one is deactivated, never deleted; the draft's order is the sortOrder.
        for (const id of removed.transfers) {
          const d = destById.get(id);
          if (!d) continue;
          if (d._count.transfers > 0) await tx.transferDestination.update({ where: { id }, data: { active: false } });
          else await tx.transferDestination.delete({ where: { id } });
        }
        const writeByKey = new Map(destWrites.map((w) => [w.key, w]));
        const usedKept = before.transferDestinations.filter((d) => removed.transfers.includes(d.id) && d._count.transfers > 0);
        if (destWrites.length || orderChanged || removed.transfers.length) {
          let order = 0;
          for (const row of draft.transfers) {
            const w = writeByKey.get(row.key);
            const sortOrder = order++;
            if (!row.id) {
              if (w) await tx.transferDestination.create({ data: { tenantId, campaignId, ...w.data, sortOrder } });
              continue;
            }
            const old = destById.get(row.id);
            if (!old) continue;
            if (w || old.sortOrder !== sortOrder) await tx.transferDestination.update({ where: { id: row.id }, data: { ...(w ? w.data : {}), sortOrder } });
          }
          for (const d of [...keptDest, ...usedKept]) await tx.transferDestination.update({ where: { id: d.id }, data: { sortOrder: order++ } });
          diff.transfers = { removed: removed.transfers.length, written: destWrites.map((w) => w.data.name), reordered: orderChanged };
        }

        if (removed.webhooks.length) await tx.webhookEndpoint.deleteMany({ where: { id: { in: removed.webhooks }, tenantId, campaignId } });
        for (const w of hookWrites) {
          if (w.id) await tx.webhookEndpoint.update({ where: { id: w.id }, data: w.data });
          else await tx.webhookEndpoint.create({ data: { tenantId, campaignId, secret: newWebhookSecret(), ...w.data } });
        }
        if (removed.webhooks.length || hookWrites.length) diff.webhooks = { removed: removed.webhooks.length, written: hookWrites.map((w) => w.data.url) };

        if (scriptChanged) {
          const version = (lastScript?.version ?? 0) + 1;
          await tx.script.create({ data: { tenantId, campaignId, version, body, active: body.length > 0 } });
          diff.script = { version };
        }

        // Switching bets on tops the campaign's agents up to the allowance (as the Games switch always has).
        if (betsChanged && bets.betsEnabled && !before.betsEnabled) {
          const agents = await tx.campaignAgent.findMany({ where: { campaignId, tenantId }, select: { user: { select: { id: true, points: true, active: true } } } });
          const reason = `Bets on for ${settings.name}: topped up to ${bets.weeklyPoints.toLocaleString()}`;
          credits = betTopUps(
            agents.map((a) => a.user),
            bets.weeklyPoints,
          ).map((t) => ({ ...t, reason }));
          for (const t of credits) {
            await tx.user.update({ where: { id: t.userId }, data: { points: { increment: t.delta } } });
            await tx.pointsLedger.create({ data: { tenantId, userId: t.userId, delta: t.delta, reason } });
          }
        }

        await tx.auditLog.create({ data: { tenantId, actorId: s.user.id, action: "campaign.save", target: campaignId, after: diff as Prisma.InputJsonValue } });
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "");
      if (target.includes("code")) return { ok: false, errors: [{ tab: "dispositions", field: "dispositions", message: "Two dispositions share a code" }] };
      return { ok: false, errors: [{ tab: "dialing", field: "settings.name", message: "Another campaign already has this name" }] };
    }
    throw e;
  }

  let warning: string | undefined;
  if (betsChanged) {
    // The consoles hear about it after the commit; a failure here loses the notice, not the setting.
    await engine("/games/bets-saved", { method: "POST", body: JSON.stringify({ tenantId, campaignId, credits }) }).catch(() => {
      warning = "Saved. The agents' consoles were not told about the games change (engine unreachable); they will see it on reload.";
    });
  }
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
  if (attach.length || detach.length) revalidatePath("/lists");
  if (betsChanged) revalidatePath("/games");
  if (diff.numbersToPool) {
    revalidatePath("/numbers");
    revalidatePath("/dids");
  }
  return { ok: true, saved: dirtyTabs(input.snapshot, draft), warning };
}
