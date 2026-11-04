# Handoff

Operating notes for whoever picks this up. docs/PLAN.md says what is being
built and why; this says how it is wired and what will trip you.

## State of the build

- **Phase 0 (foundation) is done**: monorepo, full Prisma schema from the
  plan, Clerk auth with tenant resolution, role guard, engine process with
  health + internal API + Socket.IO hub, compliance rules with tests, CI,
  Railway Dockerfiles. Nothing dials yet.
- **Phase 1 (lists and leads) is mostly done**: campaigns (settings, dial
  plans, dispositions), lists (create, assign to a campaign, duplicate
  policy), CSV upload with column mapping, affiliates with keys and
  generated posting instructions, `POST /api/v1/leads`, DNC list with
  system/campaign scope, state rules screen with a verified flag, lead
  timezone resolution. Still open from Phase 1: the Crossbar/SubscriberVerify
  litigator scrub job.
- **Deployed on Railway** (project `strowger`): services `web`, `engine`,
  `Postgres`, `Redis`, deploying from **`main`** (created 4 Nov from the
  build branch; work continues on branches and merges to `main`). Engine: https://engine-production-d809.up.railway.app,
  web: https://web-production-c3af0.up.railway.app. `ENGINE_INTERNAL_KEY`
  is a Railway-generated shared variable both services reference.
  **`CLERK_SECRET_KEY` on the web service is set by the owner in the
  Railway dashboard, never by a session.**
- **Phase 2 (preview dialing end to end) is built, pending live telephony**:
  engine jambonz hooks (registration digest check, call/AMD/status/
  conference), agent state in Redis, nailed-up agent legs as per-agent
  conference rooms, next-lead reservation with compliance checks, outbound
  dial via REST with AMD and local-presence caller ID, hangup, dispositions
  (callbacks, DNC, recycle), People page with SIP credentials, Settings
  (audio by URL, caller ID pool), and the agent console at `/agent`
  (`docs/design/`). Not yet exercised against jambonz: the account's API
  key and application SID are still to be set (`docs/JAMBONZ-SETUP.md`).
- **Phase 2b (DID manager), the cadence engine, the Crossbar scrub, Phase 3
  (ratio dialing) and Phase 4 (supervision) are built**; see their sections.
  Nothing has yet carried a real call: the jambonz API key and application
  SID are the gate (`docs/JAMBONZ-SETUP.md`).
- Next: live telephony bring-up with the owner, then Phase 5 (texting
  replies and STOP, disposition webhooks, affiliate portal, reporting) and
  the campaign-builder extras (drag-reorder, hours grid, workflow designer).

## Decisions baked into the schema

- `tenantId` on every business table. Never add one without it.
- `Lead.phone` is ten digits and unique **per list** (`@@unique([listId, phone])`).
  Cross-list duplicates inside a campaign are handled by the hopper, which
  de-dupes by phone per campaign, and by attempt counts kept per phone per
  campaign. Do not "fix" this by making phone unique per tenant.
- `DncEntry.scope` is `SYSTEM` or `CAMPAIGN`. A system entry blocks every
  campaign in the tenant.
- `StateRule` is global (not per tenant) and seeded from
  `packages/shared/src/compliance/state-rules.ts`. **`verifiedAt` is null
  until counsel confirms a row.** The seed never overwrites `verifiedAt`.
- `Campaign.ratio` never exceeds `Campaign.maxRatio`; the pacing loop owns
  the effective ratio and lowers it as the 30-day abandon rate approaches
  `abandonWarnPct`, dropping to 1:1 at `abandonCapPct`.
- `CampaignAgent.agentMode` is `FRONTER | CLOSER | BOTH`; `outboundOn` is the
  closer's checkbox, allowed only when `Campaign.closersMayDial`.

## Telephony model

- An agent's line is a **conference room named `agent-<userId>`**. Clicking
  Ready makes the browser softphone call the jambonz application; the engine
  answers with a `conference` verb (`memberTag: agent`,
  `endConferenceOnExit: true`) and records the leg's call_sid in Redis
  (`agent:<userId>.agentCallSid`, `agentsid:<sid>`). The leg stays up until
  logout. Supervisors (Phase 4) join the same room muted, or with
  `coach` to whisper.
- A lead call is created over REST with `tag: {kind: "lead", callId}`; on
  answer jambonz hits `/jambonz/call`, which replies with the optional
  disclosure `play` and a `conference` join into the agent's room
  (`startConferenceOnEnter: false`, so a lead can never sit in an empty
  room). `callsid:<sid>` in Redis maps provider call_sid to our `Call.id` for
  hooks that lack customerData.
- AMD runs on the lead leg (`/jambonz/amd?callId=`): machine + HANGUP
  policy → hangup; machine + DROP → wait for the tone, `play` the drop file,
  hangup. All prompts are `play` verbs: **no TTS anywhere**, so the account
  needs no speech vendor.
- Registration: jambonz forwards the SIP digest to `/jambonz/register`; the
  engine recomputes it from the agent's decrypted password
  (`User.sipSecret`, AES-GCM under ENGINE_INTERNAL_KEY) and returns
  `application_sid` so anything the phone dials lands in our app.
- Compliance is evaluated at reservation time (`dialer/hopper.ts`): dial
  plan by lead age and type, attempts today in the lead's local day, then
  `evaluateDialWindow`. Ineligible leads are parked 30 minutes so a scan
  does not keep re-checking the same refusal.

## Voicemail, recordings, DID hygiene (owner, 4 Nov)

- **Voicemail** per campaign: `voicemailAction` HANGUP (retry after
  `voicemailRetryMinutes`) or DROP; `voicemailMode` FILE (audio asset) or
  TTS (`voicemailScript` with {{first_name}}, {{last_name}}, {{company}},
  {{callback_number}}, {{agent}}; needs a speech vendor on the jambonz
  account). With AMD on, **preview calls are parked on a pause too**, so a
  machine never reaches the agent; the AMD hook joins humans. Agent button
  "Leave VM & next" → `/internal/calls/:id/voicemail` → jambonz redirect to
  `/jambonz/vm-drop` (pause 1 s, message, hangup), auto-disposition with the
  campaign's VM code, agent back to READY.
- **Recordings**: `Tenant.recordingRetentionDays` (default 60) and
  `recordingExport` (SFTP or Dropbox, secrets AES-encrypted). Nightly after
  06:00 UTC (`recordings/export.ts`): export un-exported recordings (bytes
  from `Call.recordingUrl` or jambonz's recent-calls recording endpoint),
  then sweep past retention (`recordingDeletedAt`, URL cleared) unless
  `legalHold`. Files: `<folder>/<YYYY-MM-DD>/<time>_<phone>_<callId>.wav`.
  Nothing flows until the jambonz account records to a bucket.
- **DID hygiene** (`shared/did-hygiene.ts`, tested): a number dials only if
  ACTIVE, `registeredAt` set (Free Caller Registry), not `restUntil`, under
  its cap (week 1 40, weeks 2–3 65, then 75, or `dailyCap`) and under the
  hourly spread (cap/10, Redis `did:hour:<hour>`). Local area code first,
  then least used. Any spam/blocked reading → SPAM_FLAGGED with a 21-day
  `restUntil`. Short calls (<10 s after answer) are counted per number
  (`shortCallsToday`). DIDs page shows all of it and bulk "mark registered".

## Campaign builder

`/campaigns/<id>/builder` (`builder.tsx`): drag-to-reorder lists (priority
becomes the rank; tiers 1 / 2 / 3+ drive weighted round robin), per-list
cadence pick, a read-only flow of what the selected list's cadence does
(the "workflow designer"; steps are edited on the cadence profile, not
drawn), attempt limits, list selection, and the day × hour schedule grid
(`Campaign.allowedHours`, 7 × 24 flags, lead's local time) which
`evaluateDialWindow` applies after the window and state rules. Launch sets
the campaign ACTIVE once it has an active list.

## Partner portal and reports (Phase 5b)

- `User.affiliateId` links an AFFILIATE-role person to an `Affiliate`
  (People → person → Partner link). `/partner` shows that partner's lists
  only: accepted / duplicate / rejected / contacted / sales over 24 h, 7 d,
  30 d and the latest posts. Nothing about other partners or agents.
- `/reports` (supervisors, room supervisors, team leaders): date range and
  campaign, KPI tiles, by disposition, by agent, and CSV exports at
  `/api/reports/{calls,dispositions,agents}.csv` behind the same role
  check. Queries live in `apps/web/src/lib/reports.ts`.

## Texting and CRM webhooks (Phase 5a)

- Inbound texts: `apps/web/src/app/api/webhooks/sms/telnyx` (Ed25519 with
  `TELNYX_PUBLIC_KEY`) and `.../sms/commio?token=SMS_WEBHOOK_TOKEN` forward
  to the engine's `handleInboundText`: tenant by the receiving number
  (`CallerIdNumber`), lead by the sender (most recent in the tenant),
  `Message` INBOUND + `LeadEvent TEXT_IN`. **STOP** (and the CTIA list,
  `shared/sms.ts`) → system `DncEntry` source STOP_KEYWORD, every lead with
  the number → DNC, callbacks cancelled, one confirmation text. HELP →
  help reply. START lifts a STOP entry. The owning agent gets `text:in`
  on the socket; the floor gets `floor:text`.
- Agent send: `/internal/sms/send` from the lead's assigned caller ID if
  SMS-enabled, else an SMS-enabled pool number matching the area code,
  refused for DNC/blocked numbers. Console: SMS panel under the call panel.
- Webhooks: `WebhookEndpoint` (tenant- or campaign-scoped, events
  disposition/sale/callback/dnc) on the campaign page; `dispositionCall`
  enqueues `WebhookDelivery`; the scheduler delivers every 30 s with
  `x-strowger-signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`,
  backoff 30 s doubling to 6 h, abandoned after 10 attempts. "Test" queues
  a sample payload.

## Supervision (Phase 4)

`apps/engine/src/supervise/`. A supervisor leg is a REST call to the
supervisor's own registered softphone (`to: {type: user}`), tagged
`kind: supervisor`; the floor page's softphone auto-answers it. On answer
the call hook joins it to the agent's room: `joinMuted` for listen,
`speakOnlyTo: agent` for whisper, open for barge. Mode changes are
`conferenceParticipantAction` coach/uncoach plus `conf_mute_status` on that
leg, so the room is never interrupted. Takeover = barge, then
`call_status: completed` on the agent's leg; the `Call` moves to the
supervisor and a COLD `Transfer` row is written. Every action is an
`AuditLog` row `supervise.<mode>` which the floor shows as action history.
Live state: Redis `supervise:<supervisorId>` and `supsid:<callSid>`.

Supervisors, room supervisors and admins get a SIP line on creation, same
as agents (People). Team leaders see their team, room supervisors their
room, supervisors and admins everything (`floorStats`).

## Ratio dialing (Phase 3)

`apps/engine/src/dialer/pacing.ts`, started from `index.ts`, one holder of
`lock:pacing` at a time, every 500 ms:

- per ACTIVE campaign in RATIO mode: `ready` = agents READY with the line
  up and nothing reserved (closers only if the campaign allows and their
  outbound switch is on); `inflight` = Redis set
  `campaign:<id>:inflight` of unbridged pacer calls; `want = floor(ready ×
  effectiveRatio) − inflight`, at most 10 per tick, **zero when nobody is
  Ready**.
- `effectiveRatio`: configured ratio (≤ maxRatio); with fewer than 50
  answered calls in 30 days capped at 2; linear step-down from
  `abandonWarnPct` to 1:1 at `abandonCapPct`. The 30-day rate comes from
  `AbandonLedger` (`answered` = human answers, `abandoned` = answers with
  no agent free), cached 30 s in Redis.
- A pacer call has `agentId null`. On answer `/jambonz/call` parks it on
  `pause 8` while AMD runs; the AMD hook's reply **replaces** the pause:
  human / no speech / decision timeout → `bridgeToReadyAgent` (longest-idle
  READY agent claims the call atomically, `patchAgent ON_CALL`, conference
  join), or safe-harbor `play` + hangup and an `abandoned` ledger row.
  Machine → the campaign's voicemail action. With AMD off the bridge
  happens on answer.
- Screener detection is on only when `SCREENER_STT_VENDOR` is set (the
  jambonz account must have that STT vendor): a `config.transcribe` runs
  on the first 12 s; a phrase match (`shared/compliance/screener.ts`)
  redirects the call to `/jambonz/screener`, which plays the message,
  bridges, or hangs up per `Campaign.screenerAction`.
- The hopper for ratio reuses the eligibility rules; the Redis sorted-set
  hopper is still an optimisation for later, Postgres handles the current
  scale.

## Cadences (list-level dial rules)

The owner's 4 Nov spec. A `CadenceProfile` hangs off a `List`; a list without
one dials by the campaign's `DialPlan`s. Lists have a `priority` tier and the
campaign a `listSelection` (strict, or weighted round robin 3:2:1).

- **FRESH + instantDial**: `POST /api/v1/leads` → web fires
  `/internal/leads/posted` → `onLeadPosted`: if the campaign is ACTIVE and
  an agent is READY with the line up, reserve them, pick the caller ID,
  send the pre-call text **from that number**, wait `instantDelaySeconds`,
  dial from the same number. No Ready agent → the lead sits at the front
  of its tier with `nextDialAt = now`; nothing is dialed with nobody to
  bridge to, ever.
- **After an attempt** (`afterAttempt`): answered + cancelRedialsOnAnswer →
  `redialsCancelledOn = today`, no more automated tries that day; missed →
  missed-call text with `{{quick_callback_link}}` (`/cb/<token>`, public,
  books a `Callback` and sets `status CALLBACK`), then `nextDialAt` from
  `nextAttemptAt` (minimum gap, daypart rotation, 24h attempt cap).
- Dayparts are in the lead's zone (`packages/shared/src/cadence.ts`, tested).
  `Lead.lastAttemptDaypart` is written at dial time.
- SMS goes through `apps/engine/src/sms/provider.ts`: `SMS_PROVIDER` =
  commio | telnyx | log. With no carrier configured, texts are logged and
  recorded as sent by provider `log`, so cadences can be exercised end to
  end without a number.

## Litigator scrub

`apps/engine/src/scrub/`: every two minutes (scheduler, Redis lock) each
tenant's PENDING leads go to Crossbar's `POST /api/agent/scrub` in batches
of 2000 with `Authorization: Bearer CROSSBAR_AGENT_KEY` (**the agent key,
not the requests or import key**: `agentGate` in Crossbar opens scrub to
that one only). Litigator → `scrubStatus LITIGATOR`, `status BLOCKED`.
Complainer → `DNC`, plus a system `DncEntry` with source CROSSBAR so the
next intake of the number stops free. Unresolved stays PENDING. With no
Crossbar configured leads are marked CLEAN with reason "No scrub source
configured", and the Compliance page says so. `Tenant.settings.scrubRequired`
makes the hopper dial CLEAN leads only; off by default so a new install
can dial before Crossbar is wired. Compliance page: counts, "Scrub pending
now", the required toggle.

## Prisma migrations here

`prisma migrate dev` refuses to run in this non-interactive session when a
migration carries a warning. Generate the SQL instead and apply it:

```bash
cd packages/db
D=prisma/migrations/$(date -u +%Y%m%d%H%M%S)_<name>; mkdir -p $D
pnpm exec prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url postgresql://strowger:strowger@localhost:5432/strowger_shadow \
  --script > $D/migration.sql
pnpm exec prisma migrate deploy && pnpm exec prisma generate
```

## Lead intake

One path, `apps/web/src/lib/intake.ts`, for uploads and posts: normalise
(`@strowger/shared` `normalizeLead`), DNC (system, then the list's campaign),
per-list duplicate policy, zone (`resolveZone`: ZIP → state, area code for
the side of a split state), `LeadEvent`. Posting requires the consent field
set (`POST_REQUIRED_FIELDS`); uploads need only a phone. A DNC hit is kept as
a `DNC` lead so reports and audit show it; it can never enter a hopper.

**CSV import runs in the browser.** `upload-wizard.tsx` parses with
papaparse, maps headers (guessed, then remembered per tenant by header set
in `Tenant.settings.importMappings`), and posts rows to server actions in
batches of 250. There is no file storage and no size ceiling to hit; a
`ListImport` row carries the counts.

**Affiliate keys** are shown once and stored as a SHA-256 hash
(`lib/affiliates.ts`). Each affiliate gets a POST list of its own at
creation and can only post into lists that carry its `affiliateId`.

## Module resolution

`tsconfig.base.json` uses `moduleResolution: "Bundler"` and relative imports
have **no extension**. Turbopack (web) cannot map `./x.js` to `./x.ts` inside
workspace packages, which is why. The engine therefore bundles with tsup
(`apps/engine/tsup.config.ts`, workspace packages inlined, `@prisma/client`
external) instead of plain `tsc`; `pnpm --filter @strowger/engine build`
makes `dist/index.js`, which the Dockerfile runs. Tests run straight from
source with `tsx`.

## Auth

Clerk authenticates; Strowger's `User` row authorises. `getSession()` in
`apps/web/src/lib/auth.ts` matches a first-time Clerk user to an invited row
by email, else sends them to `/onboarding` to create a tenant (they become
its ADMIN). `requireRole()` treats ADMIN as passing everything.

Web ↔ engine: server-side calls carry `x-engine-key: ENGINE_INTERNAL_KEY`
to `/internal/*`. Browser ↔ engine realtime: Socket.IO at `/rt` with a
short-lived HMAC token the web app mints with the same key
(`apps/engine/src/realtime.ts`).

## Environment

See `.env.example`. The engine refuses to start without `DATABASE_URL` and an
`ENGINE_INTERNAL_KEY` of 32+ characters. Clerk keys are needed for any page
behind sign-in; `pnpm build` works with test-shaped placeholder keys (CI does
this).

## Next.js 16

`apps/web` is Next 16 with `cacheComponents` turned **off** deliberately:
every route reads the session and the dialer screens are live. `proxy.ts`
is the middleware file in this version (not `middleware.ts`). Read
`node_modules/next/dist/docs/` before assuming an API from an older version.

## Railway

Two services from this one repo, each with its own `railway.json` and
Dockerfile (`apps/web`, `apps/engine`), plus Railway Postgres and Redis.
The engine container runs `prisma migrate deploy` on start. Set the
variables from `.env.example` on both; the web service also needs
`NEXT_PUBLIC_*` values at build time (they are Dockerfile build args).

## Tests

`pnpm test` runs node:test suites. The compliance window tests
(`packages/shared/src/compliance/window.test.ts`) pin the rule semantics:
most restrictive wins, state attempt caps beat campaign allowances, Sunday
rules, the federal 8am floor. Add a test whenever a rule changes.
