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
  `Postgres`, `Redis`, all from branch `claude/wonderful-hopper-kdugij`
  until there is a `main`. Engine: https://engine-production-d809.up.railway.app,
  web: https://web-production-c3af0.up.railway.app. `ENGINE_INTERNAL_KEY`
  is a Railway-generated shared variable both services reference.
  **`CLERK_SECRET_KEY` on the web service is set by the owner in the
  Railway dashboard, never by a session.**
- Next: Phase 2 (jambonz + Commio, agent softphone, preview dialing).

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
