"use server";

// Client onboarding wizard (/welcome). Every field autosaves through
// `saveStep` (no Save button); the rest are the wizard's buttons. Only a
// client admin (or the platform admin inside the client) may call them.
// docs/HANDOFF.md "Client onboarding wizard".
import { patchOnboarding, prisma } from "@strowger/db";
import { STEP_KEYS, readOnboarding, type StepKey, type TeamInvite } from "@strowger/shared/onboarding";
import { requireRole, isBarePlatform, type Session } from "@/lib/auth";
import { engine } from "@/lib/engine";
import { createCampaignRecord } from "@/lib/campaign-create";
import { createInvitedUser, sendClerkInvitation } from "@/lib/people-invite";
import type { ApplyResult, PlanOpts } from "../numbers/plan-actions";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function admin(): Promise<Session> {
  const s = await requireRole("ADMIN");
  if (isBarePlatform(s)) throw new Error("Open a client workspace first");
  return s;
}
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  const j = m.match(/"error":"(.*)"\}$/);
  return j ? j[1]!.replace(/\\"/g, '"') : m;
};
const isStep = (k: string): k is StepKey => (STEP_KEYS as readonly string[]).includes(k);

/** Autosave: the whole step's answers, as typed. */
export async function saveStep(step: string, data: Record<string, unknown>): Promise<Result<{ savedAt: string }>> {
  const s = await admin();
  if (!isStep(step) || step === "done") return { ok: false, error: "Unknown step" };
  const json = JSON.stringify(data ?? {});
  if (json.length > 40_000) return { ok: false, error: "Too much text in this step" };
  const savedAt = new Date().toISOString();
  const first = !readOnboarding(s.tenant.onboarding).meta[step]?.updatedAt;
  await patchOnboarding(s.tenant.id, [
    { set: ["steps", step], value: JSON.parse(json) },
    { merge: ["meta", step], value: { updatedAt: savedAt, skippedAt: null } },
  ]);
  if (first) await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "onboarding.step.started", target: step } });
  return { ok: true, savedAt };
}

export async function skipStep(step: string, skip: boolean): Promise<Result> {
  const s = await admin();
  if (!isStep(step) || step === "you" || step === "done") return { ok: false, error: "This step cannot be skipped" };
  await patchOnboarding(s.tenant.id, [{ merge: ["meta", step], value: { skippedAt: skip ? new Date().toISOString() : null } }]);
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: skip ? "onboarding.step.skipped" : "onboarding.step.unskipped", target: step } });
  return { ok: true };
}

/** "Submit for registration": the engine checks again, then creates the brand and the campaign at Telnyx. */
export async function submitRegistration(): Promise<Result<{ status: unknown }>> {
  const s = await admin();
  try {
    const r = await engine<{ ok: true; status: unknown }>("/onboarding/register", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id }) });
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** The first campaign (named on the Calling step, default "My first campaign") with an upload list for the leads file. */
export async function createFirstCampaign(): Promise<Result<{ campaignId: string; listId: string }>> {
  const s = await admin();
  const st = readOnboarding(s.tenant.onboarding);
  if (st.firstCampaign) {
    const still = await prisma.list.findFirst({ where: { id: st.firstCampaign.listId, tenantId: s.tenant.id, campaignId: st.firstCampaign.campaignId }, select: { id: true } });
    if (still) return { ok: true, campaignId: st.firstCampaign.campaignId, listId: st.firstCampaign.listId };
  }
  const calling = st.steps.calling ?? {};
  let name = String(calling.campaignName ?? "").trim().slice(0, 80) || "My first campaign";
  if (await prisma.campaign.findFirst({ where: { tenantId: s.tenant.id, name }, select: { id: true } })) name = `${name} (${new Date().toISOString().slice(0, 10)})`;
  const hours = Number.isInteger(calling.hoursStart) && Number.isInteger(calling.hoursEnd) && (calling.hoursStart as number) < (calling.hoursEnd as number) ? { localWindowStart: calling.hoursStart, localWindowEnd: calling.hoursEnd } : {};
  const c = await createCampaignRecord(s.tenant, { name, dialMode: "PREVIEW", ...hours });
  let listName = `${name} leads`;
  if (await prisma.list.findFirst({ where: { tenantId: s.tenant.id, name: listName }, select: { id: true } })) listName = `${listName} ${c.id.slice(-4)}`;
  const list = await prisma.list.create({ data: { tenantId: s.tenant.id, name: listName, campaignId: c.id, source: "UPLOAD" } });
  await patchOnboarding(s.tenant.id, [{ set: ["firstCampaign"], value: { campaignId: c.id, listId: list.id, createdAt: new Date().toISOString() } }]);
  await prisma.auditLog.createMany({
    data: [
      { tenantId: s.tenant.id, actorId: s.user.id, action: "campaign.create", target: c.id, after: { name, dialMode: "PREVIEW", from: "onboarding" } },
      { tenantId: s.tenant.id, actorId: s.user.id, action: "list.create", target: list.id, after: { name: listName, campaignId: c.id, from: "onboarding" } },
    ],
  });
  return { ok: true, campaignId: c.id, listId: list.id };
}

/** "Reserve these numbers": through the engine, which saves the plan for the first payment when there are no funds yet. */
export async function reserveNumbers(opts: PlanOpts): Promise<{ ok: true; result: ApplyResult; note?: string } | { ok: false; error: string }> {
  const s = await admin();
  try {
    const r = await engine<{ ok: true; result: ApplyResult; savedForPayment: boolean }>("/onboarding/reserve", {
      method: "POST",
      body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, requestedBy: s.user.email, poolFirst: opts.poolFirst, exactOnly: opts.exactOnly }),
    });
    return {
      ok: true,
      result: r.result,
      note: r.savedForPayment ? "Saved. There are no funds on the account yet, so nothing was bought: the numbers still to order are ordered automatically the moment your first payment lands (pool numbers, which are free, are already yours)." : undefined,
    };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** Team step: a person row and Clerk's sign-in invitation for each new address. */
export async function inviteTeam(rows: { email: string; name?: string; role: "AGENT" | "SUPERVISOR" }[]): Promise<Result<{ invites: TeamInvite[] }>> {
  const s = await admin();
  const out: TeamInvite[] = [];
  for (const r of rows.slice(0, 50)) {
    const email = String(r.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    const role = r.role === "SUPERVISOR" ? "SUPERVISOR" : "AGENT";
    const [first, ...rest] = String(r.name ?? "").trim().split(/\s+/);
    const row: TeamInvite = { email, name: r.name?.trim() || undefined, role };
    try {
      const existing = await prisma.user.findFirst({ where: { tenantId: s.tenant.id, email }, select: { id: true } });
      const user = existing ?? (await createInvitedUser(s.tenant, { email, firstName: first || null, lastName: rest.join(" ") || null, roles: [role] })).user;
      row.userId = user.id;
      if (!existing) await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "user.invite", target: user.id, after: { email, roles: [role], from: "onboarding" } } });
      try {
        await sendClerkInvitation(email);
        row.sentAt = new Date().toISOString();
        await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "user.invite.email", target: user.id } });
      } catch (e) {
        row.error = `Added, but the invitation email failed (${errText(e)}). They can use "Sign up" with ${email}.`;
      }
    } catch (e) {
      row.error = errText(e);
    }
    out.push(row);
  }
  const prev = (readOnboarding((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id }, select: { onboarding: true } })).onboarding).steps.team?.invites ?? []).filter((p) => !out.some((o) => o.email === p.email));
  const invites = [...prev, ...out];
  await patchOnboarding(s.tenant.id, [
    { set: ["steps", "team"], value: { invites } },
    { merge: ["meta", "team"], value: { updatedAt: new Date().toISOString(), skippedAt: null } },
  ]);
  return { ok: true, invites };
}

/** Payment step: a hosted card page when a processor is set up; otherwise the platform admin is told to send a payment link. */
export async function startPayment(amountCents: number): Promise<Result<{ setup: { mode: "none"; message: string } | { mode: "redirect"; url: string } | { mode: "embedded" }; instructions: string | null }>> {
  const s = await admin();
  const st = readOnboarding(s.tenant.onboarding);
  const email = st.steps.you?.email || s.user.email;
  const base = (process.env.WEB_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL || "https://strowger.crossbar.digital").replace(/\/+$/, "");
  try {
    const r = await engine<{ ok: true; setup: { mode: "none"; message: string } | { mode: "redirect"; url: string } | { mode: "embedded" }; instructions: string | null }>("/onboarding/payment", {
      method: "POST",
      body: JSON.stringify({ tenantId: s.tenant.id, userId: s.user.id, amountCents: Math.round(amountCents), email, returnUrl: `${base}/welcome?step=payment` }),
    });
    return { ok: true, setup: r.setup, instructions: r.instructions };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function finishOnboarding(): Promise<Result> {
  const s = await admin();
  await patchOnboarding(s.tenant.id, [{ set: ["finishedAt"], value: new Date().toISOString() }]);
  await prisma.auditLog.create({ data: { tenantId: s.tenant.id, actorId: s.user.id, action: "onboarding.finish" } });
  return { ok: true };
}
