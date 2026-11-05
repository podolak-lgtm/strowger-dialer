# Strowger: the plan

Strowger is an outbound contact center: a predictive/ratio and preview dialer
with texting, built for human agents, with TCPA compliance designed in rather
than bolted on. It runs on its own, and it plugs into Crossbar (the lead
management system) when a customer has one.

This document is the plan to be approved before code is written. Decisions the
owner has already made are stated as decisions. Open points are listed at the
end.

---

## 1. What it does

- **Lists** are loaded (CSV upload) or posted (affiliate API). A list belongs to
  exactly one **campaign** at a time; a campaign holds many lists.
- **Agents** log in, pick a campaign, click **Ready**. The dialer connects them to
  live people.
- Two dial modes at the campaign level: **Ratio** (N lines per ready agent,
  3:1 by default) and **Preview** (agent sees the lead, clicks to dial).
- Every number is **scrubbed** (own DNC, litigators, Crossbar when attached)
  before it can be dialed.
- **Voicemail** is detected (hang up, or drop a recorded message).
  **Call screeners** (Google Call Screen and the like) are detected, and the
  campaign decides: play a recorded "who and why" message, hand to an agent,
  or hang up.
- **Abandoned calls** get a safe-harbor message, are counted against a 3%
  cap per campaign, and the ratio is throttled before the cap is hit.
- **Calling windows** use the lead's local time (ZIP first, area code second)
  and apply federal and state rules; the most restrictive rule wins.
- **Retry strategy** is per lead age inside a campaign ("fresh" leads on day 1
  dial differently from day 5), capped by law. This is the part meant to be
  the product's edge, so it is a pluggable strategy from the start.
- Agents **disposition** calls, **schedule callbacks**, **text** the lead from
  the same screen, and **transfer** to closers.
- Calls are **recorded**, with an on/off recording disclosure per campaign.
- **Supervisors** see a live board and can listen, whisper, barge and take over.
- **Dispositions push** to webhooks / CRMs.
- **Multi-tenant** from the first table.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Carrier | Telnyx (SIP trunk, numbers, SMS); changed from Commio on 4 Nov |
| Call control | jambonz |
| Agent phone | Browser WebRTC softphone, Chrome first |
| Backend | Node / TypeScript |
| Tenancy | Multi-tenant from day one |
| Scale at launch | 25 concurrent agents, 500–1,000 dials each per day (~25k dials/day, ~100 concurrent channels at 3:1 with headroom) |
| Scrubbing | Own DNC list built in; Crossbar adapter optional |
| Lead identity | Phone number is the unique ID |
| Caller ID | Local presence (rotating by area code) |
| Attempts | Default max 3 per lead per day, per-lead-age schedules inside a campaign, state law as the ceiling |
| Call screener | Per-campaign: play message / hand to agent / hang up |
| Recording disclosure | Per-campaign on/off |
| Hosting | Railway for app, engine, Postgres, Redis; jambonz.cloud for telephony; no AWS for now |

## 3. Hosting

**Railway vs Fly.io.** Both run long-lived Node processes, which is what the
engine needs. Railway: GitHub auto-deploy, managed Postgres and Redis as
click-to-add services, a dashboard, usage-based billing. Fly.io: more control
(regions, machine sizes, raw VMs), CLI-driven, a bit cheaper at scale, more to
operate. For this team Railway is the right call: fewer moving parts and no
ops work until there is a reason for it. Moving to Fly or AWS later is a
Dockerfile and a connection string, because nothing here depends on Railway.

**AWS.** Yes, it is a pain: VPC, security groups, IAM, EC2 for media, and
jambonz's own install. The only reason to go there is self-hosting jambonz for
cost or control. Start on **jambonz.cloud** (hosted, supports bring-your-own
carrier, so Commio plugs in). Revisit self-hosting when the monthly bill or a
feature gap says so. The code does not change either way: jambonz is driven by
webhooks and its REST API.

**Where things run**

```
Browser (agent / supervisor / admin)
   │  HTTPS + WebSocket            │ WebRTC (SIP over WSS)
   ▼                               ▼
Railway: web (Next.js)         jambonz.cloud ──SIP──▶ Commio ──▶ PSTN
Railway: engine (Node)  ◀──webhooks/REST──┘
Railway: Postgres, Redis
Object storage (R2 or S3-compatible) for recordings
```

## 4. Architecture

Monorepo (pnpm workspaces + Turborepo):

```
apps/web        Next.js 16: admin, supervisor board, agent screen, affiliate portal
apps/engine     Node service: pacing loop, jambonz webhooks, WebSocket hub, workers
packages/db     Prisma schema + client (Postgres)
packages/shared Types, validation (zod), compliance rules, phone/timezone utils
packages/crossbar  Client for Crossbar's agent API (scrub)
```

### 4.1 The engine

One Node process (horizontally scalable later; the pacing loop takes a Redis
lock per campaign).

- **Pacing loop** (every 500 ms per active campaign): reads ready agents and
  in-flight calls from Redis, computes how many dials to place
  (`ready_agents × ratio − dialing − ringing`, minus abandon throttle), pulls
  leads from the hopper, places calls through jambonz's REST API.
- **Hopper builder** (every 30 s per campaign): fills a Redis sorted set per
  campaign with dialable leads, ordered by the campaign's strategy (LIFO on
  posted leads by default), filtered by window, attempts, state rules, DNC,
  recycle timers and callbacks due.
- **Call state machine**: jambonz webhooks drive each call through
  `dialing → ringing → answered → {human, machine, screener, failed}` →
  `bridged | voicemail_drop | abandoned | screener_action` → `ended`.
- **Agent state machine** (Redis + WebSocket): `offline → logged_in → ready →
  reserved → on_call → wrap_up → ready`, plus `paused(reason)`.
- **WebSocket hub**: pushes agent screen pops, state changes, and the
  supervisor board. Socket.IO with a Redis adapter.
- **Workers** (BullMQ on Redis): list import, scrub batches, recording
  fetch/store, webhook delivery with retries, SMS send/receive, nightly
  compliance roll-ups.

### 4.2 Telephony with jambonz

- **Agent leg.** On Ready, the agent's browser softphone (SIP.js over WSS,
  registered to jambonz) is called into the agent's own **conference room**.
  The leg stays up all session ("nailed up"), so bridging a live answer is a
  conference join, not a new call. This is what makes the 2-second
  connect rule achievable.
- **Outbound leg.** Engine → jambonz REST `createCall` with `amd` enabled,
  caller ID from the local presence pool, and the engine's webhook as the
  application. On `amd` result:
  - `human` → join the lead to a reserved agent's conference. If no agent is
    free within the abandon timer (default 2 s from greeting end), play the
    safe-harbor message, record an abandon, hang up.
  - `machine` → hang up, or wait for `beep` and play the voicemail drop.
  - **Screener detection** runs alongside AMD: jambonz `transcribe` on the
    first ~6 s; a phrase matcher ("state your name and why you're calling",
    "the person you're calling is using a screening service", and so on)
    decides `screener`, then the campaign's screener action runs.
- **Preview mode.** Same outbound path, but the agent clicks to dial and the
  agent is pre-reserved, so no abandon risk.
- **Transfers (fronter → closer).** The closer is another nailed-up conference
  member; warm transfer = closer joins the fronter's room, fronter leaves.
  Closers-only agents are never offered outbound dials.
- **Supervision.** Supervisor joins the agent's conference: muted (listen),
  `speakOnlyTo` the agent (whisper), unmuted (barge), and takeover = agent
  dropped from the room, supervisor stays.
- **Recording.** jambonz call recording to object storage, dual-channel where
  the provider allows. Disclosure prompt played on bridge when the campaign
  has it on.
- **Inbound.** Local presence numbers route back to jambonz; the engine looks
  up the last lead dialed from that number and rings an available agent on
  that campaign, with the lead's record popped.

### 4.3 Texting

Commio SMS from the same local presence numbers (10DLC registration required
per campaign; this is set up at the carrier). Telnyx as an alternative
provider behind the same interface, since Crossbar already runs on it. Inbound
texts land on the lead's timeline and alert the owning agent. Templates per
campaign; opt-out keywords (STOP) honored automatically and written to DNC.

## 5. Data model (Prisma, Postgres)

Every table carries `tenantId`. Names below are the models; fields are the
notable ones.

**Tenancy & people**
- `Tenant`
- `User` (tenant, email, role set, auth provider id)
- `Role`: `ADMIN`, `SUPERVISOR`, `ROOM_SUPERVISOR`, `TEAM_LEADER`, `AGENT`, `AFFILIATE`
- `Room` (a physical location or floor), `Team` (team leader + agents),
  `UserRoom`, `UserTeam`
- `CampaignAgent` (user ↔ campaign, `agentMode`: `FRONTER | CLOSER | BOTH`)

**Lists & leads**
- `List` (tenant, campaign, name, source `UPLOAD | POST`, affiliate, status,
  counts)
- `Lead` (tenant, list, `phone` (10 digits, unique per list), first/last
  name, address, city, state, zip, email, `timezone`, `leadType`
  (campaign-defined bucket), `postedAt`, `consentJornayaId`,
  `consentTrustedFormId`, `optInUrl`, `optInAt`, `optInIp`, `rawPayload`,
  `scrubStatus`, `scrubReason`, `attemptsToday`, `attemptsTotal`,
  `lastAttemptAt`, `nextDialAt`, `status`, `ownerAgentId`)
- `LeadEvent` (every touch: dial, text, disposition, note, webhook)
- `Affiliate` (tenant, name, `apiKey`, field mapping, default list,
  duplicate policy)
- Duplicates are judged **per list**: a phone appears once in a list. The
  affiliate / upload policy on a repeat is `REJECT | ACCEPT | UPDATE`.
  Across the lists of one campaign the same phone may exist many times, so
  the **hopper de-duplicates by phone per campaign** and the attempt caps
  are counted per phone per campaign, not per lead row. A campaign with 22
  lists never rings one person 22 times.

**Compliance**
- `DncEntry` (tenant, phone, `scope: SYSTEM | CAMPAIGN` with `campaignId`
  when campaign-scoped, source `MANUAL | STOP_KEYWORD | DISPOSITION |
  IMPORT | CROSSBAR`, note). A system entry blocks every campaign in the
  tenant; a campaign entry blocks that campaign only.
- `StateRule` (seeded, not per tenant: state, hours, max attempts per day,
  day-of-week and holiday rules, source citation, `verifiedAt`)
- `AbandonLedger` (campaign, day, answered, abandoned) — the 30-day 3% math
- `ConsentRecord` snapshots kept with the lead and never deleted on lead delete

**Campaigns & dialing**
- `Campaign` (tenant, name, `dialMode: RATIO | PREVIEW`, `ratio`,
  `maxRatio`, `abandonCapPct` 3.0, `abandonTimerMs`, `amd` on/off,
  `voicemailAction: HANGUP | DROP`, `voicemailDropAudioId`,
  `screenerAction: MESSAGE | AGENT | HANGUP`, `screenerAudioId`,
  `recordingOn`, `disclosureOn`, `disclosureAudioId`, `callerIdMode:
  FIXED | LOCAL_PRESENCE`, `localWindowStart/End`, `wrapUpSeconds`,
  `hopperOrder: LIFO | FIFO | PRIORITY`, `transferTargets`)
- `DialPlan` (campaign, `leadType`, `ageFromDays`, `ageToDays`, attempts per
  day, retry gap minutes, order weight) — the per-lead-age strategy;
  `strategy` field names a pluggable algorithm (`fixed_gap` first; later
  best-time-to-call models)
- `Disposition` (campaign, code, label, `isContact`, `isSale`, `isDnc`,
  `isCallback`, `recycleAfterMinutes`, `webhookEvent`)
- `Callback` (lead, agent, campaign, due at, `scope: AGENT | CAMPAIGN`)
- `Script` (campaign, versioned)
- `CallerIdNumber` (tenant, phone, area code, state, status, `smsEnabled`,
  last used, daily use count, spam-label flag)
- `AudioAsset` (tenant, kind, storage url)

**Calls & activity**
- `Call` (tenant, campaign, lead, agent, `direction`, `callerId`, jambonz
  call sid, timestamps for each state, `amdResult`, `screenerDetected`,
  `outcome`, `abandoned`, `disposition`, `recordingUrl`, cost)
- `AgentSession` (login/logout, state changes with timestamps for
  productivity)
- `Message` (SMS, lead, direction, provider, status)
- `Transfer` (call, from agent, to agent, kind)
- `WebhookEndpoint`, `WebhookDelivery`
- `AuditLog`

## 6. Compliance rules

Rules are data (`packages/shared/compliance/`), not scattered `if`s. For each
dial the engine evaluates: federal TSR window (8am–9pm local), state window,
state attempt cap, day/holiday rules, campaign window, dial plan, DNC.
**The most restrictive wins.** Every refusal is logged with the rule that
caused it.

Starting matrix, **to be verified by counsel before go-live** (`verifiedAt`
stays null until then). Several states changed these in 2023–2025 and they
keep moving, so the seed is a starting point, not the authority:

| State | Hours (local) | Attempts | Notes |
|---|---|---|---|
| Federal (TSR) | 8am–9pm | — | Baseline everywhere |
| Florida (FTSA) | 8am–8pm | 3 per 24h | Includes texts |
| Oklahoma | 8am–8pm | 3 per 24h | Mirrors FTSA |
| Washington | 8am–8pm | 3 per 24h | |
| Maryland | 8am–8pm | 3 per 24h | 2023 "Stop the Call" |
| Connecticut | 9am–8pm | 3 per 24h | |
| New Jersey | 8am–8pm | 3 per 24h | |
| Texas | 9am–9pm Mon–Sat, noon–9pm Sun | — | |
| Mississippi | 8am–9pm, no Sundays | — | |
| Rhode Island | 9am–6pm weekdays, 10am–5pm Sat, no Sun | — | |
| Louisiana | 8am–8pm, no Sundays/holidays | — | |
| South Carolina | 8am–9pm | — | |
| Alabama | 8am–8pm | — | |
| Utah | 8am–9pm | — | |
| New York | 8am–9pm | — | |
| Pennsylvania | 8am–9pm | — | |

Also in the rules: state holidays (no calls on listed holidays in LA, RI,
others), and reassigned-number / wireless considerations left to the scrub
layer.

**Abandon rate.** Per campaign, rolling 30 days: `abandoned / (answered by
human)`. The pacing loop lowers the effective ratio as the rate approaches
the cap (e.g. at 2.5% it steps down; at 3.0% it drops to 1:1 until the rate
recovers). Every abandoned call plays the safe-harbor message naming the
caller and a callback number, within 2 seconds of the greeting end.

## 7. Lead intake

**Upload.** CSV/XLSX, column mapping UI with remembered mappings, phone
normalisation, timezone from ZIP (fallback area code), dedupe per policy,
scrub job, import report (accepted, duplicates, bad phone, DNC, litigator).

**Posting API.** `POST /api/v1/leads` with `Authorization: Bearer <affiliate
key>`. Default fields:

```
first_name*, last_name*, phone*, address*, city*, state*, zip*,
email, jornaya_lead_id, trustedform_cert_url, opt_in_url*, opt_in_at*,
opt_in_ip, lead_type, list_id (optional; defaults to affiliate's list), custom {}
```

Synchronous response: `accepted` (with lead id), `duplicate` (with policy
action taken), `rejected` (reason: dnc, litigator, bad_phone, out_of_area,
missing_consent). Posting instructions are generated per affiliate on their
page. Posted leads enter the hopper LIFO.

## 8. Agent screen

Single page, Chrome-optimized, no plugins: status bar (Ready / Pause with
reasons / Wrap-up timer), softphone controls (mute, hold, hangup, transfer,
dialpad), lead card (editable), script panel, text thread with templates,
disposition grid with callback scheduler, call history for the lead, and a
"next lead" preview in preview mode. Keyboard shortcuts for disposition codes.

## 9. Supervision

Live board per campaign / room / team: agents with state and timer, calls in
flight, hopper depth, abandon rate today and 30-day, dials/contacts/sales per
hour. Row actions: listen, whisper, barge, take over, force pause, log out.
Team leaders see their team; room supervisors their room; supervisors
everything in the tenant.

## 10. Phases

Each phase ends with something usable.

**Phase 0 — Foundation (week 1)**
Monorepo, Prisma schema, tenancy and auth (Clerk, same as Crossbar), roles,
Railway deploy with Postgres + Redis, CI with lint/typecheck/tests.

**Phase 1 — Lists and leads (week 2)**
Upload with mapping, posting API with per-affiliate keys, dedupe policies,
own DNC, Crossbar scrub adapter, ZIP → timezone, import reports.

**Phase 2 — Preview dialing end to end (weeks 3–4)**
Campaigns, dispositions, agent screen with WebRTC softphone on jambonz +
Commio, manual/preview dial, recordings to storage, callbacks, call log,
compliance window + attempt enforcement, state rules seeded.

**Phase 3 — Ratio dialing (weeks 5–6)**
Pacing loop, hopper, AMD, voicemail drop, abandon safe harbor + ledger +
throttle, screener detection with per-campaign action, local presence pool,
dial plans per lead age, recycling.

**Phase 4 — Floor (week 7)**
Supervisor board, listen/whisper/barge/takeover, teams and rooms,
fronter/closer transfers, inbound callbacks on local presence numbers.

**Phase 5 — Contact center (week 8)**
Texting from the agent screen (Commio, STOP handling), disposition webhooks /
CRM push, affiliate status portal, reporting exports.

Later: better retry models (best time to call from history and third-party
data), desktop app wrapper, Crossbar embedding, self-hosted jambonz if the
numbers call for it.

## 11. Decisions closed on 4 Nov 2026

1. **Duplicates** are per list. DNC is per campaign or system-wide. Hopper
   de-dupes by phone per campaign so overlapping lists never pile on one
   person.
2. **Attempt caps:** campaign default 3/day; a dial plan may raise it, never
   above the state cap; the UI warns above 3.
3. **Texting:** Commio first, Telnyx behind the same interface.
4. **Auth:** Clerk.
5. **Recording retention:** 2 years default, per tenant, legal hold.
6. **Callbacks:** owner agent first, falls to campaign after 30 minutes.
7. **Closers:** same agent screen; outbound is a checkbox they (or a
   supervisor, per campaign policy) can turn on or off, not hidden.

## Later: the comic theme (owner, 5 Nov)

The landing page tells the Strowger story as a comic (owner's illustrated
strip at `apps/web/public/strowger-comic.jpg` when present, else the drawn
SVG strip in `components/strowger-comic.tsx`). The owner wants its colour
scheme (cream paper `#f6efe0`, ink `#1b1b1f`, red `#c8472b`) available as
a **theme in Settings** for the whole app later, beside the current dark
theme.

## Gamification (owner, 5 Nov)

Weekly points (10,000 every Monday) agents bet against each other on any
stat; a poker run where every qualifying outcome deals a card and the best
hand when the run ends wins a bonus. Built, **switched on per campaign**
(owner, 5 Nov): an admin or supervisor (or a team leader given the right)
enables bets on a campaign and starts a named poker run with a period, a
prize and what earns a card; agents on that campaign are told on their
console the moment it happens. The owner wants variety: rotate other games
(bingo, king of the hill, horse race, boss raid, streaks, mystery box,
fantasy draft) so it never gets boring. Agent levels 1–8 carry rights; the
owner may later tie screens to levels.
