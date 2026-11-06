"use client";

// The onboarding wizard (owner, 6 Nov): steps in a left rail with status dots,
// jump anywhere, Back / Next / Skip, every field autosaved as it is typed (the
// console lead card's pattern: a moment after typing stops, and at once on
// leaving a field or the step), a progress bar, a "why we ask" line per step,
// and the 7-day timeline box. Only contact name and email are required.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ONBOARDING_STEPS, callingNotes, onboardingProgress, recommendedPrepayment, stepDef, timeline, money, type BusinessData, type CallingData, type OnboardingState, type StepContext, type StepKey, type StepStatus, type TeamInvite, type TextingData } from "@strowger/shared/onboarding";
import { ENTITY_TYPES, OPT_IN_METHODS, USECASES, US_STATES, VERTICALS, blocking, defaultOptInWording, defaultReplies, normalizeWebsite, readyChecklist, registrationTone, validateBrand, validateCampaign, websiteProblems, type Problem, type WebsiteFindings } from "@strowger/shared/tendlc";
import { NumbersCard } from "@/components/numbers-card";
import { UploadWizard } from "../lists/[id]/upload-wizard";
import { createFirstCampaign, finishOnboarding, inviteTeam, reserveNumbers, saveStep, skipStep, startPayment, submitRegistration } from "./actions";

export interface RegistrationView {
  submitted: boolean;
  brand: { id: string | null; status: string | null; identityStatus: string | null; failureReasons: string | null };
  campaign: { id: string | null; status: string | null; failureReasons: string | null };
  campaignPending: boolean;
  error: string | null;
}

export interface WizardProps {
  tenantName: string;
  initial: OnboardingState;
  ctx: StepContext;
  startStep: StepKey;
  acting: boolean;
  rates: { seatMonthlyCents: number; perMinuteMillicents: number; numberMonthlyCents: number; prepayInstructions: string | null };
  balanceCents: number;
  provider: { id: string; configured: boolean; label: string };
  registration: RegistrationView | null;
  first: { campaignId: string; campaignName: string; listId: string; listName: string; totalLeads: number; numbersPinned: number; numbersNeeded: number } | null;
  remembered: Record<string, Record<string, string>>;
  people: { email: string; role: "AGENT" | "SUPERVISOR"; signedIn: boolean }[];
}

type Steps = OnboardingState["steps"];
type EditableKey = Exclude<StepKey, "done">;

const input = "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none";
const DOT: Record<StepStatus, { cls: string; label: string }> = {
  done: { cls: "bg-emerald-400", label: "done" },
  needs: { cls: "bg-amber-400", label: "needs info" },
  skipped: { cls: "border border-zinc-500 bg-transparent", label: "skipped" },
  todo: { cls: "bg-zinc-700", label: "not started" },
};
const STATES = [...US_STATES].sort();
const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hourLabel = (h: number) => (h === 0 || h === 24 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`);

export function Wizard(p: WizardProps) {
  const router = useRouter();
  const [steps, setSteps] = useState<Steps>(() => p.initial.steps);
  const [meta, setMeta] = useState(() => p.initial.meta);
  const [saved, setSaved] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(p.initial.steps).map(([k, v]) => [k, JSON.stringify(v ?? {})])));
  const [current, setCurrent] = useState<StepKey>(p.startStep);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [website, setWebsite] = useState<WebsiteFindings | null>(p.initial.website ?? null);
  const [checking, setChecking] = useState(false);
  const [reg, setReg] = useState(p.initial.registration ?? null);
  const [regView, setRegView] = useState<RegistrationView | null>(p.registration);
  const [paymentRequest, setPaymentRequest] = useState(p.initial.paymentRequest ?? null);
  const [invites, setInvites] = useState<TeamInvite[]>(() => p.initial.steps.team?.invites ?? []);

  // ── autosave ──
  const editable = current !== "done";
  const stepJson = editable ? JSON.stringify(steps[current as EditableKey] ?? {}) : "";
  const dirty = editable && stepJson !== (saved[current] ?? "{}") && stepJson !== "{}";
  async function flush(key: EditableKey, body: string) {
    if (body === saved[key]) return;
    setSaving(true);
    const r = await saveStep(key, JSON.parse(body) as Record<string, unknown>).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    setSaving(false);
    if (!r.ok) {
      setSaveError(`Not saved: ${r.error}`);
      return;
    }
    setSaveError(null);
    setSaved((s) => ({ ...s, [key]: body }));
    setMeta((m) => ({ ...m, [key]: { updatedAt: r.savedAt, skippedAt: null } }));
  }
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  useEffect(() => {
    if (!dirty) return;
    const key = current as EditableKey;
    const body = stepJson;
    const t = setTimeout(() => void flushRef.current(key, body), 800);
    return () => clearTimeout(t);
  }, [current, stepJson, dirty]);
  const flushNow = () => {
    if (dirty) void flush(current as EditableKey, stepJson);
  };

  // Texting starts from compliant defaults (built from the business answers) the first time it is edited.
  const set = <K extends EditableKey>(key: K, patch: Partial<NonNullable<Steps[K]>>) => setSteps((s) => ({ ...s, [key]: { ...(s[key] ?? (key === "texting" ? textingDefaults() : {})), ...patch } }));

  // ── the website check (Business step), a moment after the address stops changing ──
  const b: BusinessData = steps.business ?? {};
  const names = [b.legalName ?? "", b.dba ?? ""].filter(Boolean);
  const siteKey = JSON.stringify([normalizeWebsite(b.website), names]);
  const lastChecked = useRef(p.initial.website ? JSON.stringify([normalizeWebsite(p.initial.website.url), [p.initial.steps.business?.legalName ?? "", p.initial.steps.business?.dba ?? ""].filter(Boolean)]) : "");
  async function runCheck(key: string, url: string, n: string[]) {
    lastChecked.current = key;
    setChecking(true);
    try {
      const res = await fetch("/api/welcome/website", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ website: url, names: n }) });
      const j = (await res.json()) as WebsiteFindings & { error?: string };
      if (res.ok) setWebsite(j);
      else setWebsite({ url, checkedAt: new Date().toISOString(), reachable: false, error: j.error ?? `check failed (${res.status})`, showsName: null, privacyUrl: null, termsUrl: null, privacyNoSharing: null, smsDisclosure: null });
    } finally {
      setChecking(false);
    }
  }
  const checkRef = useRef(runCheck);
  useEffect(() => {
    checkRef.current = runCheck;
  });
  useEffect(() => {
    if (current !== "business") return;
    const url = normalizeWebsite(JSON.parse(siteKey)[0] as string | null);
    if (!url || siteKey === lastChecked.current) return;
    const n = JSON.parse(siteKey)[1] as string[];
    const t = setTimeout(() => void checkRef.current(siteKey, url, n), 1500);
    return () => clearTimeout(t);
  }, [current, siteKey]);

  // ── 10DLC status, polled while the Texting or Done step is open and the answer is not final ──
  const regStatus = regView?.campaign.status ?? regView?.brand.identityStatus ?? regView?.brand.status ?? p.ctx.registrationStatus ?? null;
  const regFinal = regView?.campaign.id ? registrationTone(regView.campaign.status) !== "pending" : false;
  useEffect(() => {
    if ((current !== "texting" && current !== "done") || !regView?.submitted || regFinal) return;
    const t = setInterval(() => {
      void fetch("/api/welcome/registration")
        .then((r) => (r.ok ? (r.json() as Promise<RegistrationView>) : null))
        .then((v) => {
          if (v) setRegView(v);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(t);
  }, [current, regView?.submitted, regFinal]);

  // ── status of every step ──
  const live: OnboardingState = { ...p.initial, steps: { ...steps, team: { invites } }, meta, website: website ?? undefined, registration: reg ?? undefined, paymentRequest: paymentRequest ?? undefined };
  const ctx: StepContext = { ...p.ctx, invitedCount: Math.max(p.ctx.invitedCount, invites.filter((i) => i.userId).length), registrationStatus: regStatus };
  const progress = onboardingProgress(live, ctx);
  const tl = timeline(new Date(p.initial.firstSeenAt ?? new Date(0).toISOString()), reg?.brandSubmittedAt ? new Date(reg.brandSubmittedAt) : null);

  const brandName = b.dba || b.legalName || p.tenantName;
  const textingDefaults = (): TextingData => ({
    usecase: "LOW_VOLUME",
    description: `${brandName} texts people who asked us for a quote or a callback: a heads-up before we call, a note if we missed them, and replies from our agents.`,
    samples: [
      `Hi Jane, this is ${brandName}. Your phone will ring in a minute about your request. If you miss us, just call this number back. Reply STOP to opt out.`,
      `${brandName}: sorry we missed you! Call us back any time${b.website ? ` or pick a time at ${normalizeWebsite(b.website)}` : ""}. Reply STOP to opt out.`,
    ],
    optInMethod: "WEB_FORM",
    optInWording: defaultOptInWording(brandName),
    optInUrl: normalizeWebsite(b.website) ?? "",
    ...defaultReplies(brandName, b.supportEmail || null),
    embeddedLink: Boolean(b.website),
    embeddedPhone: false,
    directLending: false,
    privacyUrl: website?.privacyUrl ?? "",
    termsUrl: website?.termsUrl ?? "",
  });

  const go = (k: StepKey) => {
    flushNow();
    if (k === "texting" && !steps.texting) setSteps((s) => ({ ...s, texting: textingDefaults() }));
    setCurrent(k);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const idx = ONBOARDING_STEPS.findIndex((s) => s.key === current);
  const next = ONBOARDING_STEPS[idx + 1]?.key;
  const prev = ONBOARDING_STEPS[idx - 1]?.key;
  const skip = async () => {
    if (current === "you" || current === "done") return;
    const k = current;
    setMeta((m) => ({ ...m, [k]: { ...(m[k] ?? {}), skippedAt: new Date().toISOString() } }));
    void skipStep(k, true);
    if (next) go(next);
  };

  const def = stepDef(current);
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Set up {p.tenantName}</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Jump to any step, skip what you are not ready for, and come back any time. Everything saves as you type.{p.acting ? " You are filling this in on the client's behalf." : ""}
          </p>
        </div>
        <span className="text-xs text-zinc-500" aria-live="polite">
          {saveError ? <span className="text-red-300">{saveError}</span> : saving ? "Saving…" : dirty ? "Editing…" : "All changes saved"}
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <nav aria-label="Setup steps" className="space-y-4">
          <div>
            <div className="flex justify-between text-xs text-zinc-400">
              <span>
                {progress.done} of {progress.total} steps done
              </span>
              <span>{progress.pct}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-gradient-to-r from-sky-500 to-emerald-400 transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
          <ol className="space-y-1">
            {ONBOARDING_STEPS.map((s, i) => {
              const st = progress.statuses[s.key];
              return (
                <li key={s.key}>
                  <button type="button" onClick={() => go(s.key)} aria-current={current === s.key ? "step" : undefined} className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${current === s.key ? "bg-sky-950/60 text-sky-100 ring-1 ring-sky-700" : "text-zinc-300 hover:bg-zinc-800/60"}`}>
                    <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[st].cls}`} title={DOT[st].label} />
                    <span className="flex-1">
                      {i + 1}. {s.title}
                    </span>
                    {s.key !== "done" ? <span className="text-[10px] uppercase tracking-wide text-zinc-500">{DOT[st].label === "not started" ? "" : DOT[st].label}</span> : null}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="rounded-lg border border-sky-900/70 bg-sky-950/30 p-3 text-xs leading-relaxed text-sky-100">
            <div className="mb-1 font-semibold text-sky-200">About 7 days to fully live</div>
            {tl.lines.map((l) => (
              <p key={l} className="mb-1 last:mb-0">
                {l}
              </p>
            ))}
          </div>
          {progress.missingRequired.length ? <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">Required to keep your workspace: {progress.missingRequired.join(" and ")} (step 1).</p> : null}
        </nav>

        <section className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5" onBlur={flushNow}>
          <header className="mb-5 border-b border-zinc-800 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold">{def.title}</h2>
              {current !== "done" ? <span className={`rounded-full px-2 py-0.5 text-[11px] ${progress.statuses[current] === "done" ? "bg-emerald-900/60 text-emerald-200" : progress.statuses[current] === "needs" ? "bg-amber-900/60 text-amber-200" : "bg-zinc-800 text-zinc-400"}`}>{DOT[progress.statuses[current]].label}</span> : null}
            </div>
            <p className="mt-1 text-sm text-zinc-400">{def.why}</p>
            {def.neededFor ? <p className="mt-1 text-xs text-zinc-500">Needed for {def.neededFor}.</p> : null}
          </header>

          {current === "you" ? <YouStep d={steps.you ?? {}} on={(x) => set("you", x)} /> : null}
          {current === "business" ? <BusinessStep d={b} you={steps.you?.name ?? ""} on={(x) => set("business", x)} website={website} checking={checking} recheck={() => void runCheck(siteKey, normalizeWebsite(b.website) ?? "", names)} texting={steps.texting ?? null} /> : null}
          {current === "texting" ? (
            <TextingStep
              d={steps.texting ?? textingDefaults()}
              on={(x) => set("texting", x)}
              brandName={brandName}
              brandProblems={blocking([...validateBrand(b), ...websiteProblems(website)])}
              siteChecked={Boolean(website)}
              website={website}
              reg={regView}
              regMeta={reg}
              goBusiness={() => go("business")}
              onSubmitted={(v, at) => {
                setRegView(v);
                setReg((r) => ({ ...(r ?? {}), brandSubmittedAt: r?.brandSubmittedAt ?? at, campaignSubmittedAt: v.campaign.id ? at : r?.campaignSubmittedAt, campaignPending: v.campaignPending }));
              }}
              flush={async () => {
                if (dirty) await flush("texting", stepJson);
              }}
            />
          ) : null}
          {current === "calling" ? <CallingStep d={steps.calling ?? {}} on={(x) => set("calling", x)} /> : null}
          {current === "leads" ? <LeadsStep d={steps.leads?.hasFile ?? ""} on={(v) => set("leads", { hasFile: v })} first={p.first} remembered={p.remembered} funded={ctx.funded} reserve={p.initial.reserve ?? null} campaignName={steps.calling?.campaignName?.trim() || "My first campaign"} onCreated={() => router.refresh()} /> : null}
          {current === "team" ? <TeamStep invites={invites} people={p.people} onInvited={setInvites} /> : null}
          {current === "payment" ? (
            <PaymentStep
              p={p}
              funded={ctx.funded}
              seats={Math.max(1, Number(steps.calling?.agents) || 0, invites.filter((i) => i.role === "AGENT").length, p.people.filter((x) => x.role === "AGENT").length)}
              numbers={p.first?.numbersNeeded ?? 0}
              d={steps.payment ?? {}}
              on={(x) => set("payment", x)}
              request={paymentRequest}
              onRequested={setPaymentRequest}
              email={steps.you?.email ?? ""}
            />
          ) : null}
          {current === "done" ? <DoneStep p={p} progress={progress.statuses} reg={regView} regStatus={regStatus} funded={ctx.funded} invites={invites} request={paymentRequest} go={go} onFinish={async () => {
            flushNow();
            await finishOnboarding();
            router.push(p.first ? `/campaigns/${p.first.campaignId}` : "/dashboard");
          }} /> : null}

          <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
            <button type="button" disabled={!prev} onClick={() => prev && go(prev)} className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              ← Back
            </button>
            <div className="flex items-center gap-2">
              {current !== "you" && current !== "done" && progress.statuses[current] !== "done" ? (
                <button type="button" onClick={() => void skip()} className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200">
                  Skip for now
                </button>
              ) : null}
              {next ? (
                <button type="button" onClick={() => go(next)} className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sky-400">
                  Next: {stepDef(next).title} →
                </button>
              ) : null}
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────── pieces ───────────────────────────────

function F({ label, required, hint, problems = [], value, children, wide }: { label: string; required?: boolean; hint?: string; problems?: Problem[]; value?: unknown; children: React.ReactNode; wide?: boolean }) {
  const empty = value === undefined || value === null || String(value).trim() === "";
  return (
    <label className={`block text-sm ${wide ? "md:col-span-2" : ""}`}>
      <span className="text-zinc-300">
        {label}
        {required ? <span className="text-amber-300"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
      {problems.map((pr) =>
        empty && !required ? (
          <span key={pr.message} className="mt-1 block text-xs text-zinc-500">
            Needed for 10DLC. {pr.fix}
          </span>
        ) : (
          <span key={pr.message} className={`mt-1 block text-xs ${pr.level === "error" ? "text-red-300" : "text-amber-300"}`}>
            {pr.message} <span className="text-zinc-400">{pr.fix}</span>
          </span>
        ),
      )}
    </label>
  );
}
const of = (ps: Problem[], ...fields: string[]) => ps.filter((p) => fields.includes(p.field));

function YouStep({ d, on }: { d: NonNullable<Steps["you"]>; on: (x: Partial<NonNullable<Steps["you"]>>) => void }) {
  const emailBad = Boolean(d.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email!.trim());
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <F label="Your name" required value={d.name} problems={d.name?.trim() ? [] : [{ field: "name", level: "error", message: "Required.", fix: "So we know who to talk to." }]}>
        <input className={input} value={d.name ?? ""} onChange={(e) => on({ name: e.target.value })} autoComplete="name" />
      </F>
      <F label="Email" required value={d.email} problems={!d.email?.trim() ? [{ field: "email", level: "error", message: "Required.", fix: "Where we send your account notices." }] : emailBad ? [{ field: "email", level: "error", message: "That is not an email address.", fix: "name@yourbusiness.com" }] : []}>
        <input className={input} type="email" value={d.email ?? ""} onChange={(e) => on({ email: e.target.value })} autoComplete="email" />
      </F>
      <F label="Mobile" hint="For urgent account messages only. Optional.">
        <input className={input} inputMode="tel" value={d.mobile ?? ""} onChange={(e) => on({ mobile: e.target.value })} autoComplete="tel" />
      </F>
      <F label="Role / title" hint="Optional.">
        <input className={input} value={d.title ?? ""} onChange={(e) => on({ title: e.target.value })} placeholder="Owner, operations manager…" />
      </F>
      <p className="text-xs text-zinc-500 md:col-span-2">These two are all we need to keep your workspace. Everything after this is optional, and each step says what it is needed for.</p>
    </div>
  );
}

function BusinessStep({ d, you, on, website, checking, recheck, texting }: { d: BusinessData; you: string; on: (x: Partial<BusinessData>) => void; website: WebsiteFindings | null; checking: boolean; recheck: () => void; texting: TextingData | null }) {
  const ps = validateBrand(d);
  const web = websiteProblems(website);
  const sole = d.entityType === "SOLE_PROPRIETOR";
  const list = readyChecklist(d, website, texting);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid gap-4 md:grid-cols-2">
        <F label="Entity type" problems={of(ps, "entityType")} value={d.entityType}>
          <select
            className={input}
            value={d.entityType ?? "PRIVATE_PROFIT"}
            onChange={(e) => {
              const v = e.target.value;
              // A sole proprietor registers under the owner's name: start from the contact name on the You step.
              on(v === "SOLE_PROPRIETOR" && !d.firstName && !d.lastName ? { entityType: v, firstName: you.split(" ")[0] ?? "", lastName: you.split(" ").slice(1).join(" ") } : { entityType: v });
            }}
          >
            {ENTITY_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </F>
        <F label="Industry" problems={of(ps, "vertical")} value={d.vertical}>
          <select className={input} value={d.vertical ?? ""} onChange={(e) => on({ vertical: e.target.value })}>
            <option value="">Pick one</option>
            {VERTICALS.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
        </F>
        {sole ? (
          <>
            <F label="Owner's first name" problems={of(ps, "firstName")} value={d.firstName}>
              <input className={input} value={d.firstName ?? ""} onChange={(e) => on({ firstName: e.target.value })} />
            </F>
            <F label="Owner's last name" value={d.lastName}>
              <input className={input} value={d.lastName ?? ""} onChange={(e) => on({ lastName: e.target.value })} />
            </F>
          </>
        ) : (
          <>
            <F label="Legal business name" hint="Exactly as on the IRS letter for your EIN, with LLC / Inc." problems={of(ps, "legalName")} value={d.legalName}>
              <input className={input} value={d.legalName ?? ""} onChange={(e) => on({ legalName: e.target.value })} />
            </F>
            <F label="DBA / brand name" hint="The name people see in your texts, if different. Optional." problems={of(ps, "dba")} value={d.dba ?? "x"}>
              <input className={input} value={d.dba ?? ""} onChange={(e) => on({ dba: e.target.value })} />
            </F>
            <F label="EIN (federal tax id)" problems={of(ps, "ein")} value={d.ein}>
              <input className={input} value={d.ein ?? ""} onChange={(e) => on({ ein: e.target.value })} placeholder="12-3456789" inputMode="numeric" />
            </F>
          </>
        )}
        {d.entityType === "PUBLIC_PROFIT" ? (
          <F label="Stock symbol and exchange" problems={of(ps, "stockSymbol")} value={d.stockSymbol}>
            <div className="flex gap-2">
              <input className={input} value={d.stockSymbol ?? ""} onChange={(e) => on({ stockSymbol: e.target.value.toUpperCase() })} placeholder="ACME" />
              <input className={input} value={d.stockExchange ?? ""} onChange={(e) => on({ stockExchange: e.target.value.toUpperCase() })} placeholder="NASDAQ" />
            </div>
          </F>
        ) : null}
        <F label="Website" problems={[...of(ps, "website"), ...web]} value={d.website} wide>
          <div className="flex gap-2">
            <input className={input} value={d.website ?? ""} onChange={(e) => on({ website: e.target.value })} placeholder="https://yourbusiness.com" inputMode="url" />
            <button type="button" onClick={recheck} disabled={checking || !normalizeWebsite(d.website)} className="mt-1 shrink-0 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {checking ? "Checking…" : website ? "Check again" : "Check"}
            </button>
          </div>
          {website && !checking ? (
            <span className="mt-1 block text-xs text-zinc-500">
              Checked {new Date(website.checkedAt).toLocaleTimeString()}: {website.reachable ? "opens" : "does not open"}
              {website.reachable ? ` · name ${website.showsName ? "shown" : "not found"} · privacy policy ${website.privacyUrl ? "found" : "missing"} · terms ${website.termsUrl ? "found" : "missing"}` : ""}
            </span>
          ) : null}
        </F>
        <F label="Business phone" problems={of(ps, "phone")} value={d.phone}>
          <input className={input} value={d.phone ?? ""} onChange={(e) => on({ phone: e.target.value })} inputMode="tel" placeholder="(305) 555-1234" />
        </F>
        <F label="Support email" hint="Ideally at your website's domain." problems={of(ps, "supportEmail")} value={d.supportEmail}>
          <input className={input} type="email" value={d.supportEmail ?? ""} onChange={(e) => on({ supportEmail: e.target.value })} />
        </F>
        <F label="Street address" hint="Where the business is registered. No PO Boxes." problems={of(ps, "street")} value={d.street} wide>
          <input className={input} value={d.street ?? ""} onChange={(e) => on({ street: e.target.value })} autoComplete="street-address" />
        </F>
        <F label="City" problems={of(ps, "city")} value={d.city}>
          <input className={input} value={d.city ?? ""} onChange={(e) => on({ city: e.target.value })} />
        </F>
        <div className="grid grid-cols-3 gap-3">
          <F label="State" problems={of(ps, "state")} value={d.state}>
            <select className={input} value={d.state ?? ""} onChange={(e) => on({ state: e.target.value })}>
              <option value="">–</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </F>
          <div className="col-span-2">
            <F label="ZIP" problems={of(ps, "zip")} value={d.zip}>
              <input className={input} value={d.zip ?? ""} onChange={(e) => on({ zip: e.target.value })} inputMode="numeric" />
            </F>
          </div>
        </div>
        <F label="Country" problems={of(ps, "country")} value="US">
          <select className={input} value={d.country ?? "US"} onChange={(e) => on({ country: e.target.value })}>
            <option value="US">United States</option>
            <option value="CA">Canada</option>
            <option value="OTHER">Other</option>
          </select>
        </F>
        <F label="Year founded" hint="Optional.">
          <input className={input} value={d.yearFounded ?? ""} onChange={(e) => on({ yearFounded: e.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" />
        </F>
        <F label="Employees" hint="Optional.">
          <select className={input} value={d.employees ?? ""} onChange={(e) => on({ employees: e.target.value })}>
            <option value="">–</option>
            {["1-10", "11-50", "51-200", "201-500", "501+"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </F>
      </div>
      <aside className="h-fit rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
        <div className="mb-2 font-semibold">Ready for 10DLC</div>
        <ul className="space-y-1.5">
          {list.map((r) => (
            <li key={r.label} className="flex gap-2">
              <span className={r.ok ? "text-emerald-400" : "text-zinc-600"}>{r.ok ? "✓" : "○"}</span>
              <span className={r.ok ? "text-zinc-200" : "text-zinc-400"}>
                {r.label}
                {r.detail ? <span className="text-zinc-600"> ({r.detail})</span> : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-zinc-500">These are the checks The Campaign Registry and the carriers make. Fixing them here saves a rejection and a resubmission fee. The same details prefill your Free Caller Registry profile.</p>
      </aside>
    </div>
  );
}

function TextingStep(props: {
  d: TextingData;
  on: (x: Partial<TextingData>) => void;
  brandName: string;
  brandProblems: Problem[];
  siteChecked: boolean;
  website: WebsiteFindings | null;
  reg: RegistrationView | null;
  regMeta: OnboardingState["registration"] | null;
  goBusiness: () => void;
  onSubmitted: (v: RegistrationView, at: string) => void;
  flush: () => Promise<void>;
}) {
  const { d, on, reg } = props;
  const ps = validateCampaign(d, props.brandName);
  const blockers = [...props.brandProblems, ...blocking(ps)];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const samples = d.samples?.length ? d.samples : ["", ""];
  const submitted = Boolean(reg?.submitted);
  async function submit() {
    setBusy(true);
    setErr(null);
    await props.flush();
    const r = await submitRegistration();
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    props.onSubmitted(r.status as RegistrationView, new Date().toISOString());
  }
  return (
    <div className="space-y-5">
      {submitted && reg ? <RegistrationStatus reg={reg} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <F label="What the texts are for (use case)" problems={of(ps, "usecase")} value={d.usecase}>
          <select className={input} value={d.usecase ?? "LOW_VOLUME"} onChange={(e) => on({ usecase: e.target.value })} disabled={submitted}>
            {USECASES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </F>
        <F label="Messages a month (estimate)" problems={of(ps, "monthlyVolume")} value={d.monthlyVolume}>
          <input className={input} inputMode="numeric" value={String(d.monthlyVolume ?? "")} onChange={(e) => on({ monthlyVolume: Number(e.target.value.replace(/\D/g, "")) || undefined })} disabled={submitted} />
        </F>
        <F label="Description" hint="Who sends the texts, to whom, and why." problems={of(ps, "description")} value={d.description} wide>
          <textarea rows={2} className={input} value={d.description ?? ""} onChange={(e) => on({ description: e.target.value })} disabled={submitted} />
        </F>
        {samples.map((s, i) => (
          <F key={i} label={`Sample message ${i + 1}`} problems={of(ps, `sample${i + 1}`, ...(i === 0 ? ["samples"] : []))} value={s} wide>
            <textarea rows={2} className={input} value={s} onChange={(e) => on({ samples: samples.map((x, j) => (j === i ? e.target.value : x)) })} disabled={submitted} />
          </F>
        ))}
        {!submitted && samples.length < 5 ? (
          <button type="button" onClick={() => on({ samples: [...samples, ""] })} className="w-fit text-xs text-sky-300 underline md:col-span-2">
            Add another sample
          </button>
        ) : null}
        <F label="How people agree to texts" problems={of(ps, "optInMethod")} value={d.optInMethod}>
          <select className={input} value={d.optInMethod ?? "WEB_FORM"} onChange={(e) => on({ optInMethod: e.target.value })} disabled={submitted}>
            {OPT_IN_METHODS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </F>
        <F label="Page with the form" problems={of(ps, "optInUrl")} value={d.optInUrl}>
          <input className={input} value={d.optInUrl ?? ""} onChange={(e) => on({ optInUrl: e.target.value })} placeholder="https://yourbusiness.com/quote" disabled={submitted} />
        </F>
        <F label="Consent wording people agree to" hint="The sentence next to the phone field (or what the agent reads). Prefilled with compliant wording." problems={of(ps, "optInWording")} value={d.optInWording} wide>
          <textarea rows={3} className={input} value={d.optInWording ?? ""} onChange={(e) => on({ optInWording: e.target.value })} disabled={submitted} />
        </F>
        <F label="Opt-out keywords" problems={of(ps, "optOutKeywords")} value={d.optOutKeywords}>
          <input className={input} value={d.optOutKeywords ?? ""} onChange={(e) => on({ optOutKeywords: e.target.value })} disabled={submitted} />
        </F>
        <F label="Help keywords" problems={of(ps, "helpKeywords")} value={d.helpKeywords}>
          <input className={input} value={d.helpKeywords ?? ""} onChange={(e) => on({ helpKeywords: e.target.value })} disabled={submitted} />
        </F>
        <F label="Reply to STOP" problems={of(ps, "optOutMessage")} value={d.optOutMessage} wide>
          <input className={input} value={d.optOutMessage ?? ""} onChange={(e) => on({ optOutMessage: e.target.value })} disabled={submitted} />
        </F>
        <F label="Reply to HELP" problems={of(ps, "helpMessage")} value={d.helpMessage} wide>
          <input className={input} value={d.helpMessage ?? ""} onChange={(e) => on({ helpMessage: e.target.value })} disabled={submitted} />
        </F>
        <F label="Opt-in confirmation" problems={of(ps, "optInMessage")} value={d.optInMessage ?? "x"} wide>
          <input className={input} value={d.optInMessage ?? ""} onChange={(e) => on({ optInMessage: e.target.value })} disabled={submitted} />
        </F>
        <F label="Privacy policy link" hint={props.website?.privacyUrl && !d.privacyUrl ? `Found on your site: ${props.website.privacyUrl}` : undefined} problems={of(ps, "privacyUrl")} value={d.privacyUrl}>
          <input className={input} value={d.privacyUrl ?? ""} onChange={(e) => on({ privacyUrl: e.target.value })} disabled={submitted} />
        </F>
        <F label="Terms link" hint={props.website?.termsUrl && !d.termsUrl ? `Found on your site: ${props.website.termsUrl}` : undefined} problems={of(ps, "termsUrl")} value={d.termsUrl}>
          <input className={input} value={d.termsUrl ?? ""} onChange={(e) => on({ termsUrl: e.target.value })} disabled={submitted} />
        </F>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-zinc-300 md:col-span-2">
          {(
            [
              ["embeddedLink", "Messages contain links"],
              ["embeddedPhone", "Messages contain phone numbers"],
              ["directLending", "Lending / loans"],
              ["numberPool", "More than 49 numbers"],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={Boolean(d[k])} onChange={(e) => on({ [k]: e.target.checked })} disabled={submitted} /> {l}
            </label>
          ))}
        </div>
        {of(ps, "embeddedLink", "directLending").map((pr) => (
          <p key={pr.message} className={`text-xs md:col-span-2 ${pr.level === "error" ? "text-red-300" : "text-amber-300"}`}>
            {pr.message} {pr.fix}
          </p>
        ))}
      </div>
      {!submitted ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
          {blockers.length || !props.siteChecked ? (
            <div className="text-sm text-zinc-400">
              <div className="mb-1 font-medium text-zinc-200">Before you can submit:</div>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {!props.siteChecked ? <li>Check your website on the Business step.</li> : null}
                {blockers.slice(0, 8).map((pr) => (
                  <li key={pr.field + pr.message}>{pr.message}</li>
                ))}
                {blockers.length > 8 ? <li>…and {blockers.length - 8} more.</li> : null}
              </ul>
              {props.brandProblems.length ? (
                <button type="button" onClick={props.goBusiness} className="mt-2 text-xs text-sky-300 underline">
                  Fix the business details
                </button>
              ) : null}
            </div>
          ) : (
            <p className="mb-3 text-sm text-emerald-200">Everything checks out. Submitting registers your brand and this texting campaign with The Campaign Registry through our carrier. Carriers usually answer in about 3 business days.</p>
          )}
          {err ? <p className="mt-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200">{err}</p> : null}
          <button type="button" disabled={busy || blockers.length > 0 || !props.siteChecked} onClick={() => void submit()} className="mt-3 rounded-md bg-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-40">
            {busy ? "Submitting…" : "Submit for registration"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const TONE: Record<string, string> = { approved: "bg-emerald-900/60 text-emerald-200", pending: "bg-amber-900/60 text-amber-200", rejected: "bg-red-900/60 text-red-200", none: "bg-zinc-800 text-zinc-400" };
function RegistrationStatus({ reg }: { reg: RegistrationView }) {
  const brandTone = registrationTone(reg.brand.identityStatus ?? reg.brand.status);
  const campTone = reg.campaign.id ? registrationTone(reg.campaign.status) : reg.campaignPending ? "pending" : "none";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
      <div className="mb-2 font-semibold">Texting registration</div>
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          Brand <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] ${TONE[brandTone]}`}>{brandTone}</span>
          <div className="text-xs text-zinc-500">{[reg.brand.status, reg.brand.identityStatus].filter(Boolean).join(" · ") || "submitted"}</div>
          {reg.brand.failureReasons ? <div className="mt-1 text-xs text-red-300">{reg.brand.failureReasons}</div> : null}
        </div>
        <div>
          Campaign <span className={`ml-1 rounded-full px-2 py-0.5 text-[11px] ${TONE[campTone]}`}>{campTone}</span>
          <div className="text-xs text-zinc-500">{reg.campaign.status ?? (reg.campaignPending ? "waiting for the brand to be verified; sent automatically when it is" : "not submitted")}</div>
          {reg.campaign.failureReasons ? <div className="mt-1 text-xs text-red-300">{reg.campaign.failureReasons}</div> : null}
          {reg.campaignPending && reg.error ? <div className="mt-1 text-xs text-zinc-500">Last answer: {reg.error}</div> : null}
        </div>
      </div>
      <p className="mt-2 text-xs text-zinc-500">This page checks the status every 30 seconds while it is open. Rejected? Fix what the reason says (often the website or the samples) and tell us; we resubmit.</p>
    </div>
  );
}

function CallingStep({ d, on }: { d: CallingData; on: (x: Partial<CallingData>) => void }) {
  const start = d.hoursStart ?? 9;
  const end = d.hoursEnd ?? 20;
  const states = d.states ?? [];
  const notes = callingNotes(start, end, states);
  const toggle = (s: string) => on({ states: states.includes(s) ? states.filter((x) => x !== s) : [...states, s] });
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <F label="What do you call people about?" hint="Used for your first campaign's name and script." value={d.about} wide>
          <textarea rows={2} className={input} value={d.about ?? ""} onChange={(e) => on({ about: e.target.value })} placeholder="Homeowners who asked for a solar quote" />
        </F>
        <F label="First campaign name" hint='Default "My first campaign".'>
          <input className={input} value={d.campaignName ?? ""} onChange={(e) => on({ campaignName: e.target.value })} placeholder="My first campaign" />
        </F>
        <F label="Agents who will dial" hint="For the recommended first payment.">
          <input className={input} inputMode="numeric" value={d.agents ? String(d.agents) : ""} onChange={(e) => on({ agents: Number(e.target.value.replace(/\D/g, "")) || undefined })} />
        </F>
        <F label="Calling hours (the lead's local time)">
          <div className="flex items-center gap-2">
            <select className={input} value={start} onChange={(e) => on({ hoursStart: Number(e.target.value), hoursEnd: end })}>
              {HOURS.slice(0, 24).map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
            <span className="text-zinc-500">to</span>
            <select className={input} value={end} onChange={(e) => on({ hoursEnd: Number(e.target.value), hoursStart: start })}>
              {HOURS.slice(1).map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          {start >= end ? <span className="mt-1 block text-xs text-red-300">The end must be after the start.</span> : null}
        </F>
        <F label="Do you take inbound calls?" hint="People calling your numbers back.">
          <div className="mt-2 flex gap-4">
            {(["yes", "no"] as const).map((v) => (
              <label key={v} className="flex items-center gap-2 text-zinc-300">
                <input type="radio" name="inbound" checked={d.inbound === v} onChange={() => on({ inbound: v })} /> {v === "yes" ? "Yes" : "No"}
              </label>
            ))}
          </div>
        </F>
      </div>
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-zinc-300">States you call ({states.length})</span>
          <span className="flex gap-3 text-xs">
            <button type="button" className="text-sky-300 underline" onClick={() => on({ states: STATES })}>
              All
            </button>
            <button type="button" className="text-sky-300 underline" onClick={() => on({ states: [] })}>
              None
            </button>
          </span>
        </div>
        <div className="grid grid-cols-6 gap-1 sm:grid-cols-9 md:grid-cols-[repeat(13,minmax(0,1fr))]">
          {STATES.map((s) => (
            <button key={s} type="button" onClick={() => toggle(s)} aria-pressed={states.includes(s)} className={`rounded px-1.5 py-1 font-mono text-xs ${states.includes(s) ? "bg-sky-500 text-zinc-950" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {notes.length ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
          <div className="mb-2 font-semibold">State rules for the states you call</div>
          <p className="mb-2 text-xs text-zinc-500">Strowger enforces the most restrictive rule for each lead automatically; this is what that means for you. States not listed follow the federal 8am–9pm.</p>
          <ul className="space-y-2 text-xs">
            {notes
              .filter((n) => n.hasRule || n.clipped)
              .map((n) => (
                <li key={n.state} className={n.clipped ? "text-amber-200" : "text-zinc-300"}>
                  {n.lines.join(" ")}
                </li>
              ))}
          </ul>
          {notes.every((n) => !n.hasRule && !n.clipped) ? <p className="text-xs text-zinc-400">None of these states has a rule stricter than the federal one for your hours.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function LeadsStep(props: { d: string; on: (v: "yes" | "no") => void; first: WizardProps["first"]; remembered: WizardProps["remembered"]; funded: boolean; reserve: OnboardingState["reserve"] | null; campaignName: string; onCreated: () => void }) {
  const { first } = props;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setErr(null);
    const r = await createFirstCampaign();
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    props.onCreated();
  }
  return (
    <div className="space-y-5">
      <div>
        <div className="text-sm text-zinc-300">Do you have a file of leads ready?</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["yes", "Yes, I have a file"],
              ["no", "Not yet"],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" onClick={() => props.on(v)} aria-pressed={props.d === v} className={`rounded-md border px-4 py-2 text-sm ${props.d === v ? "border-sky-500 bg-sky-950/60 text-sky-100" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {props.d === "no" ? <p className="text-sm text-zinc-400">No problem. Load one any time from Leads → Lists; Strowger works out the local numbers it needs then.</p> : null}
      {props.d === "yes" && !first ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
          <p className="text-zinc-300">
            We will create your first campaign, <b>{props.campaignName}</b> (name it on the Calling step), with a list for this file. Then pick a CSV, match its columns, and we look at the area codes to plan your numbers.
          </p>
          {err ? <p className="mt-2 text-red-300">{err}</p> : null}
          <button type="button" disabled={busy} onClick={() => void create()} className="mt-3 rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-50">
            {busy ? "Creating…" : "Create the campaign and upload my file"}
          </button>
        </div>
      ) : null}
      {first ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="mb-2 text-sm font-semibold">
              Upload into {first.listName} <span className="font-normal text-zinc-500">({first.totalLeads.toLocaleString()} leads so far)</span>
            </div>
            <UploadWizard listId={first.listId} remembered={props.remembered} inCampaign />
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="mb-2 text-sm font-semibold">Numbers for {first.campaignName}</div>
            {!props.funded ? <p className="mb-3 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">No funds on the account yet. &ldquo;Reserve these numbers&rdquo; takes free numbers from our pool now and saves the rest of the plan: it is ordered automatically the moment your first payment lands.</p> : null}
            {props.reserve?.state === "pending_funds" ? <p className="mb-3 rounded-md border border-sky-900 bg-sky-950/40 px-3 py-2 text-xs text-sky-100">Saved {new Date(props.reserve.savedAt).toLocaleString()}: ordered when your first payment lands ({props.reserve.summary}).</p> : null}
            {props.reserve?.state === "applied" ? <p className="mb-3 rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-100">Reserved: {props.reserve.summary}.</p> : null}
            <NumbersCard key={`${first.listId}-${first.totalLeads}`} campaignId={first.campaignId} scope="campaign" onApply={reserveNumbers} buttonLabel="Reserve these numbers" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TeamStep({ invites, people, onInvited }: { invites: TeamInvite[]; people: WizardProps["people"]; onInvited: (v: TeamInvite[]) => void }) {
  const [rows, setRows] = useState<{ email: string; name: string; role: "AGENT" | "SUPERVISOR" }[]>([{ email: "", name: "", role: "AGENT" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = rows.filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim()));
  async function send() {
    setBusy(true);
    setErr(null);
    const r = await inviteTeam(ready);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    onInvited(r.invites);
    setRows([{ email: "", name: "", role: "AGENT" }]);
  }
  const known = [...new Map([...people.map((x) => [x.email, { email: x.email, role: x.role, note: x.signedIn ? "signed in" : "invited" }] as const), ...invites.map((i) => [i.email, { email: i.email, role: i.role, note: i.error ?? (i.sentAt ? "invitation emailed" : "added") }] as const)]).values()];
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-[2fr_2fr_1fr_auto]">
            <input className={input} type="email" placeholder="agent@yourbusiness.com" value={r.email} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
            <input className={input} placeholder="Name (optional)" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <select className={input} value={r.role} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, role: e.target.value as "AGENT" | "SUPERVISOR" } : x)))}>
              <option value="AGENT">Agent</option>
              <option value="SUPERVISOR">Supervisor</option>
            </select>
            <button type="button" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)} className="mt-1 text-xs text-zinc-500 hover:text-zinc-300" aria-label="Remove row">
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setRows([...rows, { email: "", name: "", role: "AGENT" }])} className="text-xs text-sky-300 underline">
            Add another person
          </button>
          <button type="button" disabled={busy || ready.length === 0} onClick={() => void send()} className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-40">
            {busy ? "Sending…" : `Send ${ready.length || ""} invitation${ready.length === 1 ? "" : "s"}`}
          </button>
        </div>
        {err ? <p className="text-sm text-red-300">{err}</p> : null}
        <p className="text-xs text-zinc-500">Each person gets an email to create their sign-in. Agents land on their dialer screen; supervisors see the floor and reports. Seats are charged only when an agent first logs into the dialer each month.</p>
      </div>
      {known.length ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
          <div className="mb-2 font-semibold">Your team ({known.length})</div>
          <ul className="space-y-1 text-xs">
            {known.map((k) => (
              <li key={k.email} className="flex flex-wrap justify-between gap-2">
                <span className="text-zinc-200">{k.email}</span>
                <span className="text-zinc-500">
                  {k.role === "SUPERVISOR" ? "Supervisor" : "Agent"} · {k.note}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PaymentStep(props: { p: WizardProps; funded: boolean; seats: number; numbers: number; d: NonNullable<Steps["payment"]>; on: (x: Partial<NonNullable<Steps["payment"]>>) => void; request: OnboardingState["paymentRequest"] | null; onRequested: (r: NonNullable<OnboardingState["paymentRequest"]>) => void; email: string }) {
  const { p, d } = props;
  const rec = recommendedPrepayment({ seats: props.seats, seatMonthlyCents: p.rates.seatMonthlyCents, perMinuteMillicents: p.rates.perMinuteMillicents, numbers: props.numbers, numberMonthlyCents: p.rates.numberMonthlyCents });
  const amount = d.amountCents ?? rec.recommendedCents;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ message: string; instructions: string | null } | null>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    const r = await startPayment(amount);
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    if (r.setup.mode === "redirect") {
      window.location.assign(r.setup.url);
      return;
    }
    props.onRequested({ amountCents: amount, requestedAt: new Date().toISOString(), provider: p.provider.id });
    setAnswer({ message: r.setup.mode === "none" ? r.setup.message : "Card form coming up.", instructions: r.instructions });
  }
  return (
    <div className="space-y-5">
      {props.funded ? <p className="rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-100">Your account has funds ({money(p.balanceCents)}). Dialing and number orders are open. You can add more any time from Billing.</p> : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-sm">
          <div className="mb-2 font-semibold">Recommended first payment: {money(rec.recommendedCents)}</div>
          <ul className="space-y-1 text-xs text-zinc-400">
            {rec.lines.map((l) => (
              <li key={l.label} className="flex justify-between gap-3">
                <span>{l.label}</span>
                <span className="tabular-nums text-zinc-300">{money(l.cents)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-3 border-t border-zinc-800 pt-1">
              <span>One month, estimated</span>
              <span className="tabular-nums text-zinc-200">{money(rec.totalCents)}</span>
            </li>
          </ul>
          <p className="mt-2 text-[11px] text-zinc-500">Seats from the Calling and Team steps, numbers from your leads file&apos;s plan. Prepaid: you are only charged for what you use, and the balance carries over.</p>
        </div>
        <div className="space-y-3 text-sm">
          <div className="text-zinc-300">How much to start with?</div>
          {[rec.recommendedCents, Math.max(10_000, Math.round(rec.recommendedCents / 2 / 10_000) * 10_000), rec.recommendedCents * 2]
            .filter((v, i, a) => a.indexOf(v) === i)
            .map((v) => (
              <label key={v} className="flex items-center gap-2 text-zinc-300">
                <input type="radio" name="amount" checked={amount === v} onChange={() => props.on({ amountCents: v })} /> {money(v)}
                {v === rec.recommendedCents ? <span className="text-xs text-emerald-300">recommended</span> : null}
              </label>
            ))}
          <label className="flex items-center gap-2 text-zinc-300">
            Other: $
            <input className={`${input} mt-0 w-32`} inputMode="decimal" defaultValue="" placeholder={(amount / 100).toFixed(0)} onChange={(e) => {
              const v = Math.round(Number(e.target.value.replace(/[^0-9.]/g, "")) * 100);
              if (v >= 100) props.on({ amountCents: v });
            }} />
          </label>
          {p.provider.configured ? (
            <button type="button" disabled={busy} onClick={() => void go()} className="rounded-md bg-emerald-400 px-4 py-2 font-semibold text-emerald-950 hover:bg-emerald-300 disabled:opacity-50">
              {busy ? "Opening…" : `Add a card and pay ${money(amount)}`}
            </button>
          ) : (
            <div className="rounded-lg border border-sky-900 bg-sky-950/40 p-3 text-sky-100">
              <p>Card payments are being set up. We&apos;ll email you a secure payment link; you can also pay by wire or ACH.</p>
              {p.rates.prepayInstructions ? <p className="mt-2 whitespace-pre-line text-xs text-sky-200/80">{p.rates.prepayInstructions}</p> : <p className="mt-2 text-xs text-sky-200/70">Wire / ACH details come with the payment link.</p>}
              <button type="button" disabled={busy} onClick={() => void go()} className="mt-3 rounded-md bg-sky-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-sky-300 disabled:opacity-50">
                {busy ? "Sending…" : props.request ? `Ask again for a ${money(amount)} payment link` : `Send me a payment link for ${money(amount)}`}
              </button>
            </div>
          )}
          {err ? <p className="text-red-300">{err}</p> : null}
          {answer || props.request ? (
            <p className="rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-100">
              {answer?.message ?? "Payment link requested."} We&apos;ve told our team: the link goes to {props.email || "your email"}
              {props.request ? ` (requested ${new Date(props.request.requestedAt).toLocaleString()}, ${money(props.request.amountCents)})` : ""}.
            </p>
          ) : null}
          <p className="text-[11px] text-zinc-500">Strowger never sees or stores your card number: cards are taken on our payment processor&apos;s secure page.</p>
        </div>
      </div>
    </div>
  );
}

function DoneStep(props: { p: WizardProps; progress: Record<StepKey, StepStatus>; reg: RegistrationView | null; regStatus: string | null; funded: boolean; invites: TeamInvite[]; request: OnboardingState["paymentRequest"] | null; go: (k: StepKey) => void; onFinish: () => Promise<void> }) {
  const { p, progress: st } = props;
  const tone = registrationTone(props.regStatus);
  const reserve = p.initial.reserve;
  const now: string[] = ["Your workspace and your admin sign-in."];
  const pending: string[] = [];
  const nextSteps: { label: string; href?: string; step?: StepKey }[] = [];
  if (p.first) now.push(`Campaign "${p.first.campaignName}" with ${p.first.totalLeads.toLocaleString()} leads.`);
  else nextSteps.push({ label: "Load your leads file", step: "leads" });
  if (p.first?.numbersPinned) now.push(`${p.first.numbersPinned} caller-ID number${p.first.numbersPinned === 1 ? "" : "s"} on the campaign.`);
  if (reserve?.state === "pending_funds") pending.push(`Numbers saved for your first payment: ${reserve.summary}.`);
  if (props.funded) now.push("Funds on the account: dialing and number orders are open.");
  else pending.push(props.request ? `Your first payment (${money(props.request.amountCents)} payment link requested).` : "Your first payment: dialing and new numbers start when it lands.");
  if (tone === "approved") now.push("Texting registration (10DLC) approved.");
  else if (props.reg?.submitted || tone === "pending") pending.push(`Texting registration (10DLC) under review${props.regStatus ? ` (${props.regStatus})` : ""}: usually about 3 business days.`);
  else if (tone === "rejected") pending.push("Texting registration needs changes: see the Texting step.");
  else nextSteps.push({ label: "Submit your texting registration", step: "texting" });
  const team = new Set([...p.people.map((x) => x.email), ...props.invites.filter((i) => i.userId).map((i) => i.email)]);
  if (team.size) now.push(`${team.size} team member${team.size === 1 ? "" : "s"} invited.`);
  else nextSteps.push({ label: "Invite your agents", step: "team" });
  if (p.first?.numbersPinned) pending.push("New numbers need the Free Caller Registry (Numbers → Reputation) before they dial, so they are not labelled spam.");
  return (
    <div className="space-y-5 text-sm">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-4">
          <div className="mb-2 font-semibold text-emerald-200">Live now</div>
          <ul className="list-disc space-y-1 pl-5 text-zinc-300">
            {now.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-4">
          <div className="mb-2 font-semibold text-amber-200">Pending</div>
          {pending.length ? (
            <ul className="list-disc space-y-1 pl-5 text-zinc-300">
              {pending.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-400">Nothing waiting.</p>
          )}
        </div>
      </div>
      {nextSteps.length ? (
        <div>
          <div className="mb-1 font-semibold">Next steps</div>
          <ul className="space-y-1">
            {nextSteps.map((n) => (
              <li key={n.label}>
                {n.step ? (
                  <button type="button" onClick={() => props.go(n.step!)} className="text-sky-300 underline">
                    {n.label}
                  </button>
                ) : (
                  <Link href={n.href!} className="text-sky-300 underline">
                    {n.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <a href="/agent" target="strowger-agent" className="rounded-md border border-sky-700 px-4 py-2 text-sky-200 hover:bg-sky-950">
          Open the agent console
        </a>
        {p.first ? (
          <Link href={`/campaigns/${p.first.campaignId}`} className="rounded-md border border-zinc-700 px-4 py-2 text-zinc-200 hover:bg-zinc-800">
            Open {p.first.campaignName}
          </Link>
        ) : null}
        <Link href="/numbers" className="rounded-md border border-zinc-700 px-4 py-2 text-zinc-200 hover:bg-zinc-800">
          Numbers
        </Link>
      </div>
      <div className="border-t border-zinc-800 pt-4">
        <button type="button" onClick={() => void props.onFinish()} className="rounded-md bg-emerald-400 px-5 py-2 font-semibold text-emerald-950 hover:bg-emerald-300">
          {Object.entries(st).filter(([k]) => k !== "done").every(([, v]) => v === "done") ? "Finish setup" : "Finish for now"}
        </button>
        <p className="mt-2 text-xs text-zinc-500">Finishing hides the &ldquo;Finish setup&rdquo; banner. You can reopen this page from Settings any time.</p>
      </div>
    </div>
  );
}
