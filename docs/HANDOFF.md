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
  web: **https://strowger.crossbar.digital** (custom domain live 5 Nov;
  `NEXT_PUBLIC_APP_URL`, `WEB_PUBLIC_URL` and the first entry of the
  engine's `WEB_ORIGIN` list point at it; the Railway URL
  https://web-production-c3af0.up.railway.app still works). `ENGINE_INTERNAL_KEY`
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
  (ratio dialing), Phase 4 (supervision) and external transfers (cold /
  warm to campaign destinations, 5 Nov) are built**; see their sections.
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

## Inbound contact center (owner, 4 Nov)

`apps/engine/src/inbound/router.ts`. A call to one of our numbers follows
`CallerIdNumber.routeTo`:

- **CAMPAIGN**: the callback path (owner → campaign → anyone Ready; nobody
  → callback booked + message in the "<Campaign> callbacks" box).
- **USER**: direct DID → that agent if Ready, else their own box
  (auto-created).
- **IVR**: `gather` on digits with the greeting file; options are
  `{digit, label, action, targetId}` (QUEUE | USER | VOICEMAIL | IVR |
  HANGUP); extensions (`User.extension`, up to 4 digits + #) can be dialed
  when `allowExtensions`; no input repeats `repeats` times then the
  timeout action.
- **QUEUE**: Redis sorted set `queue:<id>` + `enqueue` verb with hold music
  from `waitHook`. The 1 s `queues` job assigns the first qualified agent
  (`qualifiedAgents`: free, every required skill at ≥ min level, highest
  total rating, then longest idle; a queue with no skills prefers its
  campaign's agents) by REST-redirecting the caller to `/jambonz/bridge`,
  and overflows past `maxWaitSeconds` to voicemail / another queue / hangup.
- **Voicemail**: greeting, `/beep.wav`, then `listen` streams the caller to
  the engine's `/audio/voicemail` WebSocket (`inbound/recorder.ts`); on
  close the PCM is wrapped as WAV into the media bucket
  (`voicemail/<tenant>/<id>.wav`, served by the web `/api/media`) and the
  `Voicemail` row gets duration + URL; owner notified `voicemail:new`.
  The engine therefore holds the bucket's `S3_*` variables too.

Admin: `/inbound` (routing, IVRs, queues, boxes), `/skills` (skills,
ratings, extensions), `/voicemails` (agents see their own; supervisors all).

## Team leaders on the console, and chat (5 Nov)

- **Team leader = an agent with a team.** `TEAM_LEADER` (and supervisors
  or admins who log into the console) gets a **My Team** panel in the
  right column of the main screen and on the assist screen: the members
  of the teams they lead (`Team.leaderId`, Teams & rooms), each with live
  state and time in state from the `floor:agent` socket events the
  engine already broadcasts, a **Message** button that opens a direct
  chat, and **listen / whisper / barge / stop** on a member who is on a
  call. Monitoring uses the leader's own softphone (the same supervision
  legs as the floor, `floor/actions.ts`), so it is enabled only while the
  leader's line is registered and idle (not Ready in a room); the console
  softphone now auto-answers an incoming call when idle and declines it
  when the line is in a room (only supervision legs ever ring an agent).
- **Chat** (`apps/engine/src/chat`, `lib/chat-actions.ts`,
  `components/chat-panel.tsx`): `ChatMessage` rows with channels
  EVERYONE, MANAGERS (admin, supervisor, room supervisor, team leader),
  TEAM (members + leader; managers may read), CAMPAIGN (its agents +
  all managers), DIRECT (`a:b`, ids sorted). The engine checks
  membership on send and read, stores, and emits `chat:message` to each
  recipient's `agent:<id>` room (EVERYONE goes to the tenant room). The
  panel is on the console (both screens) and the floor (both views),
  with unread counts per channel and a people list for direct messages.
  No history pruning yet.
- **No desk phone is needed**: the agent's phone is the browser softphone
  (WebRTC to jambonz over `JAMBONZ_WSS_URL`) with a USB headset. A desk
  VoIP phone could register with the agent's SIP credentials instead,
  but nothing requires it.

## Callbacks go to the agent who touched the lead; voicemail alerts; levels; assist; games (5 Nov)

- **Call-back routing**: `Lead.lastAgentId` is set whenever an agent
  dispositions a call, sends a text, or leaves a voicemail (`dispositionCall`,
  `/internal/sms/send`, `agentVoicemailDrop`). The inbound CAMPAIGN route
  tries `lastAgentId`, then `ownerId`, then the longest-waiting Ready agent on
  the campaign, then anyone free. Nobody free: a callback is booked and the
  message goes to the **personal box** of `lastAgentId ?? ownerId`
  (`boxForUser`), else the campaign box. `ownerId` keeps its hopper meaning
  (reserved / callback owner) and is untouched by this.
- **Voicemail alert by text**: `recorder.ts` `alertAgent` texts the box
  owner's `User.mobilePhone` when `User.notifyVoicemailSms` (Voicemails page,
  "My preferences") and the call's `Campaign.voicemailNotifySms` (campaign
  page) are both on; from the first SMS-enabled pool number, purpose
  `vm_alert`.
- **Agent levels 1–8**: `User.level` (People → person). Rights
  (`AGENT_RIGHTS` in `shared/games.ts`: manual dial, send text, transfer,
  assist screen, Everyone chat, games, manage games, leaderboard, voicemail
  drop, skip lead) default by level (`DEFAULT_LEVEL_RIGHTS`; `OPT_IN_RIGHTS`
  such as `manage_games` are on no level until the tenant ticks them) and are overridden per
  tenant in Settings → Agent levels (`Tenant.settings.levelRights`).
  `lib/rights.ts` `rightsOf(session)`: supervisors/room supervisors/admins
  have everything; team leaders follow their level. Console actions call
  `requireRight`; the console gets `rights` to hide what it may not do (so
  far: games). Screens per level is the owner's next idea; the matrix is
  where that goes.
- **Agent assist**: `Campaign.rebuttals` (campaign page, "objection | what
  to say" lines) shown in the console's Assist panel (assist screen; on the
  main screen while on a call) with a search box; **Suggest** posts what the
  person said to `/internal/assist/suggest` (`apps/engine/src/assist`,
  Claude structured output: three things to say, why, a tone cue; goal sale
  or service) with the script, rebuttals and lead as context. Live
  transcript-driven cues still wait on a speech vendor.
- **Script templates** (owner, 5 Nov): `packages/shared/src/scripts.ts`
  exports `SCRIPT_TEMPLATES` (`{ key, name, body, rebuttals }`), tested.
  First entry is the National Solar Resolutions "Solar Exit" fronter
  (opener, recording disclosure, five qualifying questions, empathy
  lines, inline rebuttals, warm-transfer bridge, voicemail), written with
  the console's `{{variables}}`. The campaign page's "Agent script" and
  "Agent assist: rebuttals" cards use `TemplateTextarea`
  (`campaigns/[id]/template-textarea.tsx`, client): a "Load a template"
  select + button fills the textarea (confirming before it overwrites
  text); nothing is stored until the card's Save. The rebuttal card's
  placeholder is the first template's rebuttals in line format. Add a
  template by appending to the array; the test checks keys are unique
  and only known variables are used.
- **Games are per campaign** (owner, 5 Nov: "enable this at the campaign
  level"; `apps/engine/src/games`, rules in `shared/games.ts`, tested).
  `Campaign.betsEnabled` (default off), `Campaign.weeklyPoints`,
  `Campaign.maxStake`; the Settings → Games card now holds only the defaults
  a new campaign starts with (`Tenant.settings.games.weeklyPoints/maxStake`;
  the migration `20261105220000_campaign_games_poker_runs` copied the old workspace values
  onto existing campaigns, bets off). Switches live on the campaign page
  ("Games" card, `campaigns/[id]/games-card.tsx` → `campaigns/games-actions.ts`)
  and on `/games` ("Run the games" card) for whoever `canManageGames`
  (`lib/rights.ts`: ADMIN/SUPERVISOR, or a TEAM_LEADER whose level carries the
  opt-in right `manage_games`, which no level has by default). The web actions
  (`lib/games-actions.ts`) call the engine (`/internal/games/bets`,
  `/internal/games/run`), which writes the audit log and emits the realtime
  notices.
  - **Bets** (`Wager.campaignId`): `proposeWager` needs the campaign's
    `betsEnabled`; accept re-checks it. `User.points` stay per person (one
    purse across campaigns): the Monday top-up sets each agent to the largest
    `weeklyPoints` among their ACTIVE bets-on campaigns, and **switching bets
    on tops up the campaign's agents at once** so the first week is playable.
    Instant bets settle on the dialer hooks of that campaign (bets with no
    campaign, from before, settle on any); period bets count `Call` rows on
    the bet's campaign.
  - **Poker runs are explicit** (`PokerRun`: campaign, name, `startsAt`/
    `endsAt`, prize text, `qualifies` SALE|CONTACT|CODES + `qualifyingCodes`,
    ACTIVE|ENDED, `createdById`, `winnerId`/`winningHand` once ended). One
    ACTIVE run per campaign. `PokerCard.runId` links cards; `earnsCard`
    (shared) decides on every disposition of a live run. Ending (button, or
    the `pokerRuns` job 5-minutely once `endsAt` passes) ranks hands with
    `bestHand`, stores the winner and shows it under "Past runs" on `/games`.
    Cards from before runs keep `runId` null and are history only.
  - **It reaches the agents**: Socket.IO `games:run` {status, campaignId,
    name, prize, endsAt|winner} and `games:bets` {campaignId, betsEnabled,
    weeklyPoints} to the tenant room, `games:won` to the winner. The console
    shows the one-line notice for its campaign on screen ("Poker run '…'
    started: …") and `GamesPanel` (now per campaign, with the run, days
    left, the agent's hand, bets waiting and a quick bet) reloads on any
    `games:*` event. When neither bets nor a run are on it says so plainly
    instead of hiding.
  - **The agent sees it** (owner, 5 Nov: "The agent should actually see
    their cards. It should be graphical. It should be fun ... The same with
    the points. Agents should be able to make bets with each other.").
    - Cards: `components/playing-card.tsx` (`PlayingCard` sm/md/lg, pure
      CSS + SVG pips, red hearts/diamonds, a comic back for an empty slot,
      `aria-label` "Seven of hearts"; `PokerHand` five slots, the cards that
      make the hand lifted with an amber outline, the hand in words under it;
      `RunLeaderboard` everyone's best five as small cards, leader on a red
      halftone). Used by the console and `/games` (supervisors see the same
      table). Words and ranking are shared rules, tested: `cardLabel`,
      `describeHand` ("Two pair, kings and sevens", "Royal flush"),
      `handMakers`, `rankStandings` (compareHands; ties share a place),
      `placeLine` ("You're 2nd of 6"), `timeLeft` ("2 days 5 hours left").
      The engine's `RunSummary.rows` now carry `place` and `hand.label/makers`;
      a run's `winningHand.hand` is the described hand from now on.
    - Console wiring: `app/(console)/agent/games.tsx`. `useGames` holds one
      overview for the whole console (reloads on every `games:*`), the deal
      queue and the toasts. The Games panel is on **both** screens now (main:
      right column under Chat; assist: as before).
    - Deal moment: `games:card` {card, runId, run, campaignId, hand} queues a
      card; `GamesLayer` plays it (back flips to face, "+1 card", run name,
      the hand so far, ~2.3 s, ✕ to dismiss) only while the agent is **not
      ON_CALL** (held until wrap-up/Ready). Wide screens: fixed bottom-right
      over the Chat column, clear of the call and disposition column; below
      `xl` it sits in the page flow under the notice line, so it covers
      nothing. The old text notice for a card is gone.
    - Purse: `PointsPurse` in the top bar ("12,500 pts" on a chip) counts up
      or down on any reload that changes `points` (rAF, 0.9 s; a +/- delta
      floats), click for the last 10 ledger rows with `ledgerKind` (top-up,
      stake, bet won, bet lost, refund). A loss now writes a **0-delta
      "Lost: …" ledger row** for the loser at settlement (the stake left at
      bet time) so it shows in the history; `ledgerKind` parses the reason
      strings in `credit()` calls, so keep their prefixes.
    - Bets between agents: the panel's bet board (challenges to me with
      Accept/Decline, my open and live bets with Withdraw, open-to-anyone
      with Take it, recently settled on the campaign and mine with the
      winner) and a Challenge form (agent on the campaign from the overview's
      new `players`, or anyone; kind; stake slider capped at
      min(`maxStake`, purse); trash talk `WAGER_NOTE_MAX` = 80, also enforced
      by the engine). **Decline** is new: `declineWager` (rule
      `declinePlan`/`wagerActions` in shared, tested) sets DECLINED and
      refunds the proposer; route action `decline`. `games:wager` now carries
      names, short label (`WAGER_SHORT`), stake and note; the console turns a
      challenge to me into a toast with Accept/Decline, and a settlement into
      "Maria won 500 pts from you on Next sale" for each side
      (`settlementLine`). Rows in the overview carry `actions` for the viewer.
    - Look: dark console with comic touches from the landing page (2px black
      outlines, hard drop shadows, `.sw-halftone` / `.sw-halftone-red` dots,
      the comic red `#c8472b` and cream `#f6efe0`). Keyframes are in
      `globals.css` (`sw-deal-*`, `sw-pop`, `sw-float-up`, `sw-toast-in`) and
      all switch off under `prefers-reduced-motion`. No sounds.
- Other games the owner asked for ideas on (not built): outcome bingo,
  king of the hill, horse race, team boss raid, streak multiplier, mystery
  box, fantasy draft; see the reply of 5 Nov.

## Billing (owner, 5 Nov): prepaid, per seat + per minute, everything billable

`apps/engine/src/billing`, `BillingAccount` (one per tenant: balance in
cents, the client's rate plan, low-balance threshold, grace days,
suspension), `BillingEntry` (the ledger: charges negative, payments
positive, `costCents` = what we paid, `period` YYYY-MM), `PlatformRates`
(one row: Telnyx per-minute in/out, number per month, scrub per record,
text per segment, prepay instructions). `Tenant.isPlatform` marks the
owner's workspace (the first tenant created, by migration): it is never
billed and sees `/platform`.

- **Seat** = an agent (not ADMIN/SUPERVISOR/ROOM_SUPERVISOR) who logs into
  the dialer; charged once per user per month at first login
  (`chargeSeatIfNew` in `/internal/agents/login`). Default $70.
- **Minutes**: `chargeCallMinutes` from `leadCallEnded` (inbound and
  outbound), answered-to-ended by the second at the per-minute price
  (default 1.2¢); cost from the platform rates by direction.
- **Numbers**: `chargeDidMonthly` when a number becomes ready in
  provisioning and on the first scheduler tick of each month for every
  active number (`monthlyDids`); price = cost + `didMarkupPct` (50).
- **Scrub**: `chargeScrub` in the scrub job for every record Crossbar
  checked; price = cost + `scrubMarginMillicents` (0.5¢). The cost rate
  defaults to 0.5¢ and must be corrected from the SubscriberVerify invoice.
- **Texts**: `chargeSms` on every sent message (default 1.5¢ a segment;
  segments counted as 1 for now).
- **Prepay**: no cards. The owner records payments on `/platform` (wire,
  check); `recordPayment` lifts a suspension at once. Balance ≤ 0 starts
  `zeroSince`; the hourly `billingSuspend` job pauses outbound (agent
  login, lead dial, manual dial refuse with a clear message) after
  `graceDays` (3). The sidebar badge (supervisors) and the console top bar
  (everyone) go amber below `lowBalanceCents` ($200) with a runway estimate
  from the 30-day average, red at zero.
- Client page `/billing`: balance, month to date, rates, prepay
  instructions, by-category totals, ledger, past statements by month.
  Owner page `/platform`: every client's balance / revenue / cost /
  margin, record a payment, per-client plan, cost rates.
- **Vendor actuals** (`billing/vendor.ts`, owner: "get the pricing in via
  the API on everything"): the hourly `telnyxCosts` job pulls Telnyx
  `GET /v2/detail_records` for `sip-trunking` (matched to `Call` by
  direction, far-end number and start time within three minutes),
  `messaging` (matched by `Message.providerMessageId` = record uuid), and
  the per-record extras (amd, conference legs, recording, storage, stt,
  tts, webrtc: unattributed), plus `GET /v2/balance`. Every record lands in
  `VendorUsage` (unique on vendor + record id, so re-pulls are idempotent);
  matched calls/texts get `vendorCostCents` and their `BillingEntry`
  `costCents` is replaced with `costSource: "telnyx"`. AI requests
  (classify, assist) are costed from `res.usage` at Opus 5.5 list price
  ($4/$20 per MTok, cache read $0.20, write $5) into `VendorUsage` with
  the tenant. The scrub has no price API: rate only. `/platform` shows
  the Telnyx balance, vendor spend by kind, unattributed total, and a
  "pull last 7 days" button (`/internal/billing/vendor/sync`).
- **Client workspaces** (`apps/engine/src/workspaces`): `/platform` creates
  a workspace (tenant + billing account + optional admin user by email),
  **Open** sets the `strowger_ws` cookie so a platform admin works inside
  that tenant as ADMIN (`getSession` returns the target tenant with
  `actingFrom`; a banner with "Back" sits on every page), and **Move
  campaign** calls `moveCampaign` (one transaction: campaign, lists, leads
  + events, calls + transfers + voicemails, messages, callbacks,
  dispositions, dial plans, scripts, webhooks, abandon ledger, sessions,
  campaign-scoped DNC, number orders, numbers pinned to it, agents who work
  only this campaign with their voicemail box and game rows; cadence
  profiles and audio copied by name; system DNC copied). Agents who also
  work other campaigns stay and are dropped from the moved campaign.
- **Bare platform vs. inside a client** (owner, 5 Nov: opened Campaigns in
  the platform workspace, saw a blank page, thought the app broke). The
  platform tenant holds no campaigns, so with no client opened
  (`isBarePlatform(session)` in `lib/auth.ts`: `tenant.isPlatform` and no
  `actingFrom`) the `(app)` layout shows only Platform, People and
  Settings plus a "pick a client" note, and every campaign-scoped page
  (dashboard, campaigns, lists, leads, numbers, dids, inbound, cadences,
  affiliates, compliance, voicemails, games, reports, teams, skills,
  billing, partner, and their `[id]` pages) calls `requireClientWorkspace`
  instead of `requireRole` / `requireSession`, which redirects to
  `/platform?pick=1` there. Inside a client (`actingFrom` set) a
  full-width sky band sits above the nav and content with the client's
  name, its balance badge and "Back to platform"; the sidebar shows the
  client name with "via <platform>". `openWorkspace` also stores
  `User.lastWorkspaceId` (migration `last_workspace`) so `/platform`
  offers "Continue in <client>" (the remembered one, else the only one);
  it never enters a client silently. Non-platform tenants are untouched.
- **NSR split** (migration `nsr_workspace`, 5 Nov): the original workspace
  became the client "National Solar Resolutions" (everything in it stayed:
  numbers, campaign, agents, carrier ids, settings) and the owner's admin
  user moved to a new empty platform tenant `crossbar-platform`
  (`tnt_crossbar_platform`). The owner works in NSR through "Open" on
  /platform. Runs once; a no-op where `crossbar-platform` exists.
- Not done: invoices as PDF, card payments, tax, proration of seats,
  Telnyx managed sub-accounts per client (would make cost attribution
  exact instead of matched).

## Carrier: Telnyx

Chosen 4 Nov over Commio. Voice: a jambonz carrier named `Telnyx`
(`JAMBONZ_CARRIER`); SMS: `SMS_PROVIDER=telnyx` with `TELNYX_API_KEY` on
the engine and `TELNYX_PUBLIC_KEY` on web for inbound webhook signatures.
`docs/TELNYX-SETUP.md` has the portal steps. The Commio SMS adapter stays
in `sms/provider.ts` for a second trunk later.

## Number provisioning from Strowger (`/numbers`, 4 Nov)

Owner's rule: a campaign's DIDs are ordered, attached and registered
before the campaign dials, from one screen. `apps/engine/src/provision/`:

- `telnyx.ts`: Telnyx v2 REST (shapes from the published OpenAPI spec:
  available numbers, number orders, phone numbers, FQDN connections and
  FQDN records, outbound voice profiles, messaging profiles, 10DLC brand /
  campaignBuilder / phoneNumberAssignmentByProfile). `jambonz-admin.ts`:
  jambonz REST for VoipCarriers, SipGateways, PhoneNumbers (the SDK client
  only covers calls/conferences/queues).
- **Setup** (`setupCarrier`, idempotent, reuses by name): outbound voice
  profile "Strowger"; FQDN connection "Strowger (jambonz)" with
  credential auth outbound and an FQDN record for the jambonz SBC
  (`JAMBONZ_SBC_FQDN`, default = `JAMBONZ_SIP_REALM`, which on
  jambonz.cloud resolves to the SBC; correct it from the portal's
  Carriers page if inbound calls do not arrive) set as primary inbound
  route; messaging profile "Strowger – <tenant>" with webhook
  `WEB_PUBLIC_URL/api/webhooks/sms/telnyx` (one per tenant, because 10DLC
  campaigns attach to a profile); jambonz carrier `JAMBONZ_CARRIER` with
  the connection's username/password as outbound auth, outbound gateway
  `sip.telnyx.com:5060`, inbound gateways = Telnyx signalling IPs
  (`TELNYX_SIGNALLING_IPS`, from sip.telnyx.com/voice.json, US + CA). Ids
  are stored on `Tenant` (`telnyx*Id`, `jambonzCarrierSid`). The voice
  connection and carrier are shared across tenants on one Telnyx/jambonz
  account; the messaging profile is per tenant.
- **Order** (`orderNumbers`): `NumberOrder` row → Telnyx number order
  with connection + messaging profile → `CallerIdNumber` rows
  (`provider telnyx`, `provisionStatus ordered`, `orderId`, pinned to the
  chosen campaign or shared) → `syncOrder` finishes numbers Telnyx reports
  `success`: `finishNumber` confirms the number is `active`, sets
  connection/profile if missing, adds it to jambonz PhoneNumbers under the
  carrier and `JAMBONZ_APPLICATION_SID`, and marks `ready` (`voice` when
  there is no messaging profile). The scheduler job `numberOrders` (3 min)
  re-syncs pending orders. `registeredAt` stays null: the number will not
  dial until marked registered at the Free Caller Registry on /dids.
- **Sync** (`syncNumbers`): adopts numbers on the Telnyx account that we
  do not know (on our connection or unassigned), finishes pending ones,
  links `manual` numbers that turn out to be at Telnyx, retires numbers
  gone from the account. **Release** deletes at Telnyx and jambonz and
  retires the row (status `released`).
- **10DLC**: brand (`POST /10dlc/brand`) and campaign
  (`/10dlc/campaignBuilder`) are submitted from the page; snapshots and
  ids on `Tenant` (`tenDlc*`); status refreshes on every page load;
  "Assign all numbers" calls `phoneNumberAssignmentByProfile` once the
  campaign status is accepted/provisioned. Opt-out/help keyword lists sent
  to TCR match `shared/sms.ts`.
- **Free Caller Registry** (First Orion / Hiya / TNS) has no API: a web
  form with email-code verification and a certification that the business
  itself calls from the numbers. `/api/reports/fcr` (`?all=1` for every
  active number) downloads the one-number-per-line .txt their bulk upload
  takes; the DIDs page walks through the form and then "Mark all as
  registered". **Automatic run** (5 Nov, owner: "we have an inbox in
  Crossbar"): `apps/engine/src/provision/fcr.ts` drives the form with
  Playwright (Chromium installed in the engine image, Dockerfile):
  contact email = an address at crossbar.digital saved in Settings →
  Free Caller Registry profile (`Tenant.settings.fcr`); the registry's
  "captcha" field is the five-character code it emails; the engine polls
  Crossbar `GET /api/agent/inbox?to=&since=` (lead-marketplace branch
  `claude/agent-inbox`, agent key) for up to four minutes, enters it,
  fills business details (the form validates the address with AWS
  Location, so it must be real), uploads the numbers file, ticks the
  certification, submits, and records the feedback id on the profile and
  `registeredAt` on the numbers. Route `/internal/provision/fcr` (several
  minutes; the web action waits). Failures come back with the step they
  stopped at; nothing is marked registered then. Telnyx Number Reputation ($100/mo per enterprise + per
  query, LOA required) is the candidate feed for the carrier grid; not
  wired (owner asked 5 Nov whether it is free: it is not).
- Errors from either API come back to the page verbatim (`?msg=`); every
  action is audit-logged (`provision.*`). The engine's internal routes are
  under `/internal/provision/*`.

## Media bucket

Railway bucket `media` (S3-compatible, region sjc). The web service reads
it through `${{media.*}}` references as `S3_*` (never copied values).
`lib/storage.ts` uploads prompts under `audio/<tenantId>/<random>.<ext>` and
serves them from `/api/media/<key>` (public read, unguessable key, so the
dialer fetches prompts with no session). Settings → Audio files has
upload and URL. The same bucket is the natural target for jambonz call
recording: in the jambonz portal, Account → recording, use the bucket's
endpoint, name and keys from the Railway dashboard.

## External transfers (owner, 5 Nov)

The agent hands a live lead to a phone number the campaign lists, cold or
warm. The customer is never put on hold: no hold music, no private consult.
`apps/engine/src/dialer/transfers.ts`; pure rules and constants in
`packages/shared/src/transfers.ts` (tested).

- **Models.** `TransferDestination` (per campaign: name, E.164 `phone`,
  `type` COLD|WARM = the default for the console's flip, `callerIdMode`
  CUSTOMER|STATIC with `staticCallerId` = one of the workspace's numbers,
  `whisperOn`, `whisperText` template, `sortOrder`, `active`). Campaign
  page → **Transfers** card: add, edit, ↑↓ reorder, deactivate, remove (a
  destination that has been used is deactivated, never deleted), and
  **Copy from another campaign** (its active destinations; same names are
  skipped). `Transfer` gained `destinationId`, `destinationCallId`,
  `callerIdShown`, `callerIdFallback`, `answeredAt`, `agentLeftAt`,
  `endedAt`, `outcome` (ANSWERED | NO_ANSWER | CANCELLED | FAILED); its
  existing `kind` is the mode used (COLD|WARM). The destination leg is its
  own `Call` row, `direction TRANSFER`, `parentCallId` = the lead's call,
  `destinationId`, `agentId null`, so `chargeCallMinutes` bills both legs
  (note "Transfer leg") and the Telnyx CDR matcher (`billing/vendor.ts`,
  outbound records now match OUTBOUND | MANUAL | TRANSFER by far-end number)
  attributes its cost. Reports, the floor's counts and the console's sprint
  exclude `TRANSFER` rows from dials. `LeadEvent` kinds TRANSFER_STARTED,
  TRANSFER_ANSWERED, TRANSFER_NO_ANSWER, TRANSFER_CANCELLED, AGENT_LEFT.
  Migration `20261105223000_external_transfers`. `moveCampaign` moves the
  destinations with the campaign.
- **Call flow.** `startExternalTransfer` (`POST
  /internal/calls/:id/transfer-external {userId, destinationId, mode}`)
  checks the call is the agent's, answered and live, picks the caller ID,
  writes the `Transfer` + leg `Call`, renders the whisper, and
  `jambonz.calls.create`s the destination with `tag {kind: "transfer",
  transferId}`, `timeout` = `TRANSFER_RING_SECONDS` (25) and `timeLimit` =
  `TRANSFER_CAP_MINUTES` (90) × 60. Hooks: `/jambonz/call` routes
  `kind: transfer` (or Redis `xfersid:<sid>`) to `transferLegVerbs`, which
  replies `say` (the whisper, destination only: it is on its own leg, not
  in any room yet) then a `conference` verb; `/jambonz/status` routes the
  leg's lifecycle to `transferLegStatus`; `/jambonz/conf?transferId=&leg=`
  to `transferConfEvent`.
  - **COLD**: the destination joins a fresh room `xfer-<transferId>`
    (`startConferenceOnEnter: true`, `endConferenceOnExit: true`). On its
    `join` event the engine calls `agentLeaveTransfer(..., "auto")`, which
    REST-redirects the lead leg to `/jambonz/xfer-join?leg=lead` (same
    room, same flags). The agent's room is empty again and the agent's
    nailed-up leg is untouched, so after a cold transfer answers the agent
    can disposition, go Ready and take the next call while the lead and
    the destination keep talking. (Kick/mute of the agent was rejected:
    the agent must be free; this is why the pair moves rooms instead.)
  - **WARM**: the destination joins the agent's room (`memberTag:
    destination`, three-way). **Leave** = `agentLeaveTransfer(...,
    "leave")`: both the lead and the destination are redirected into
    `xfer-<transferId>`. **Cancel transfer** (ringing, or warm before
    Leave) = `cancelTransfer`: a Redis `xfer:cancel:<id>` flag, then
    `call_status` completed/no-answer on the destination leg; the status
    hook records CANCELLED and the lead stays with the agent.
  - **No answer** (busy / no-answer / failed, or the 25 s timeout):
    outcome NO_ANSWER or FAILED, LeadEvent, console "No answer at
    <name>", agent keeps the lead.
  - **After the agent leaves** both legs in `xfer-<id>` carry
    `endConferenceOnExit: true`, so whichever side hangs up ends the room
    and the other leg's next verb is `hangup`; the destination leg's
    `timeLimit` is the 90-minute cap and ends the lead the same way.
    `transferJoinVerbs` for the lead replies `hangup` when the transfer
    has already ended (the far side was gone before the lead arrived), so
    a lead never sits in an empty room.
  - The lead leg ending for any reason while a transfer is in flight
    (`leadCallEnded` → `endLiveTransfersForCall`) hangs the destination
    up. After the agent has left, `leadCallEnded` neither touches the
    agent's state nor emits to their console (they may be on a new call);
    the console also ignores an "ended" for a call that is not the one on
    screen (`callIdRef`).
- **Disposition and wrap-up.** When the agent leaves (cold auto-drop or
  warm Leave) the call is dispositioned at once with the campaign's
  **Transferred** disposition (code `XFER`, `isContact`, created by
  `transferredDisposition` if missing) and the note "Transferred to <name>
  (cold|warm)". `dispositionCall` takes `keepWrapUp: true` for this: it
  writes everything (lead status, events, webhooks) but leaves the agent
  in WRAP_UP on the call, so the console shows the disposition grid with a
  banner ("Transferred to X … keep it, or pick another") and a **Keep**
  button; whatever they click re-dispositions the call (a second
  DISPOSITION event and webhook delivery: acceptable) and moves them to
  READY.
- **Caller ID shown to the destination.** `chooseTransferCallerId`
  (shared, tested): CUSTOMER = the lead's own number as the `from` of the
  destination leg; STATIC = the destination's fixed number, only while it
  is still one of the workspace's active numbers; otherwise the campaign's
  caller ID that dialled the lead, logged, with `Transfer.callerIdFallback
  = true`. A carrier refusal of a non-owned `from` arrives as a **4xx
  after** `calls.create` (the INVITE is answered asynchronously): the
  status hook sees `failed` with `sip_status` 401/403/407 before answer
  and `transferLegStatus` redials the same leg row once from the
  campaign's number, marking the fallback. A synchronous create error does
  the same once. The console's caller-ID chip shows "they see <number>
  (fallback)" and the Transfer row carries it for reports. Telnyx normally
  allows any `from` on a credential connection only when the number is
  owned or the account has caller-ID override enabled: ask Telnyx support
  to enable it for the "Strowger (jambonz)" connection if the fallback
  shows up on every transfer.
- **Whisper.** `renderWhisper` with `whisperVars` (`{{company}}`,
  `{{campaign}}`, `{{destination}}`, `{{agent}}`, `{{lead.firstName}}`,
  `{{lead.lastName}}`, `{{lead.phone}}`, `{{lead.city}}`,
  `{{lead.state}}`, plus the script spellings `first_name`, `last_name`,
  `city`, `state`); `renderTemplate` now accepts dotted keys. Default:
  "Transfer from {{company}}, {{campaign}}. Lead {{lead.firstName}}
  {{lead.lastName}}." The `say` verb uses the jambonz account's default
  speech vendor, like TTS voicemail: **with no speech vendor on the
  account, turn `whisperOn` off per destination** or the destination
  hears silence before joining.
- **Realtime.** `call:update` with `status: "transfer"` and a `transfer`
  object (`transferView`: id, state ringing | answered | no_answer |
  cancelled | failed | left | ended, destinationName, mode, callerIdShown,
  callerIdFallback, agentLeftAt, dispositionId/Label on "left") to the
  agent; `floor:call` `transfer_<state>` to the tenant. The console's
  **Transfer…** button opens a dropdown: the campaign's active destinations
  (name, a cold/warm chip that flips on click, a "they see <number>" chip)
  plus the closers free right now (the existing closer transfer, unchanged).
  While in flight: "Ringing <name>…" + Cancel; warm connected: Leave +
  Cancel transfer; cold connected: "handing off…" then wrap-up. `GET
  /internal/calls/:id/transfer` restores the state on a reload. The floor
  (`/internal/transferred`, `FloorStats.transferred`) lists "Transferred,
  still connected" calls (lead, destination, mode, agent, time since the
  agent left) under the agent list, so a handed-off call does not vanish.
- **Rights.** Everyone who can take calls may use the destinations (no
  level gate; the closer transfer keeps `transfer`). New right
  `transfer_any_number` ("Transfer to any typed number") exists in
  `AGENT_RIGHTS`, off at every default level (tested); no UI for a typed
  number yet.
- **Recording** is the jambonz account's (see Media bucket): the
  destination leg and the lead leg are calls under the same account, so a
  recording-on account keeps recording after the agent leaves. Nothing per
  campaign is sent on the new legs yet; when per-call recording verbs
  arrive, add them to `transferLegVerbs` and `transferJoinVerbs` under
  `Campaign.recordingOn`.
- Not built: typed-number transfers, a transfer report, DTMF to the
  destination, a supervisor view into `xfer-<id>` rooms (listen/whisper
  target the agent's room only).

## Mid-call controls (`dialer/controls.ts`)

- **Hold**: `conf_hold_status` on the lead leg.
- **Warm transfer to a closer** (the in-dialer kind; external numbers are
  the section above): the closer is claimed first (ON_CALL), the lead leg is
  redirected to `/jambonz/transfer` which joins the closer's room; the
  fronter's `Call` closes with a `Transfer` row and a second `Call` under
  the closer inherits the provider call sid (so status hooks follow it);
  the lead's owner becomes the closer; fronter → WRAP_UP. Targets =
  READY agents on the campaign with the line up, closers first.
- **Manual dial**: typed number → DNC (system + campaign) and the window
  by the lead's or area code's zone, then the normal dial. Unknown numbers
  become a lead in a per-campaign "Manual dials" list (priority 9) so they
  report like everything else.
- `/leads`: find a lead by phone, name or email; calls, texts, timeline,
  consent evidence, DNC hits.

## Inbound calls, teams and rooms, hardening

- **Inbound** (`dialer/inbound.ts`): a PSTN call to one of our numbers
  (`CallerIdNumber`) becomes an INBOUND `Call`; the lead is the most recent
  with the caller's phone. Routed to the lead's owner if READY, else the
  longest-idle READY agent on the number's campaign, else anywhere in the
  tenant; bridged into that agent's room with a screen pop
  (`call:update.inbound`). Nobody free → a CAMPAIGN (or owner) callback due
  now, lead → CALLBACK, caller hears the safe-harbor/hold file and the call
  ends. Recording a message waits for cloud recording on the account.
- **Teams & rooms** (`/teams`): rooms with a room supervisor, teams with a
  leader and optional room, and a who-sits-where table (one team, one room
  per person; a team inside a room places its members in the room). The
  floor's scope reads these.
- Posting API: per-affiliate token bucket (300/min, burst 60) → 429 with
  Retry-After. Tenant goals (Settings) feed the sprint bars. Campaign page
  shows the 30-day abandon rate from the ledger against warn/cap.

## Two-screen agent console

`/agent` is the main window (softphone lives here). `/agent?screen=assist`
is the second monitor: campaign script personalised for the lead on
screen, upcoming leads (read-only view of what the hopper would offer),
the agent's callbacks for the next 8 hours, the current lead's text
thread, leaderboard and goals. The assist window follows the main window
through the agent's own socket events (`agent:state.reservedLeadId`,
`call:update.leadId`). The "2 screens" toggle (localStorage
`strowger.twoScreen`) opens the assist window on Log in; the open happens
inside the click so browsers allow it, under the window name
`strowger-assist` so there is only ever one. Scripts are versioned
(`Script`), edited on the campaign page. When the softphone fails to
register, the "phone error" badge and the "Softphone error: …" banner text
are buttons: a click drops the existing JsSIP client and calls
`connectPhone()` again (badge reads "registering…" meanwhile); the console
also retries once by itself 10 s after a failure, then leaves it to the
click. The error text keeps the user, realm and server. The big status
banner is the primary Ready/Pause control (owner, 5 Nov): it is a
`<button>` with an `aria-label` when READY (opens the pause-reason menu
under the banner), PAUSED ("… · click to resume" → `goReady`) or LOGGED IN
with the softphone registered ("click to go Ready" → `goReady`); ON CALL
and WRAP-UP are plain. The top-bar "Go Ready" / "Pause…" buttons stay as
secondary controls; `pauseMenu` records which anchor opened the menu.

**Dispositions under the call controls (owner, 5 Nov, first-day
feedback).** The Call Dispositions panel is no longer in the left column:
it renders directly under the "Call in Progress / Call ended" panel (Mute /
Hold / Leave VM & next / End Call), so controls and dispositions are one
block, and only while on a call or in wrap-up. Choosing a disposition on a
live call hangs up first (`hangup(callId)`, awaited) and then dispositions;
End Call + disposition is no longer two steps. The console remembers the
dispositioned call id (`dispositionedRef`) and ignores the lead leg's
later `call:update ended` for it, since that event can land after the
disposition already cleared the call. Two callback buttons are always
present, whatever the campaign's disposition list: **Callback** puts the
lead back for this agent (status CALLBACK, owner = agent) due now +
`campaign.callbackOwnerMinutes` (60 when 0; the minutes go to the server
action as `callbackInMinutes`, which computes the time, because the React
Compiler lint forbids `Date.now()` in render-created handlers), and
**Scheduled callback** opens the date/time picker inline with Submit /
Cancel; the disposition is sent only on Submit, with `callbackAt`. Both use
the campaign's `isCallback` disposition; when the campaign has none the
console sends no `dispositionId` and the engine (`dispositionCall`,
`callbackDisposition()`) finds-or-creates a default "Callback" disposition,
code `CB`, on the campaign. Campaign callback dispositions are filtered out
of the grid (the two buttons replace them); their hotkey opens the
scheduled picker and submits it once a time is set. Other hotkeys work on
the call and in wrap-up, never while typing in an input. Wrap-up is
unchanged: the engine moves the agent to READY after the disposition.

**Lead card (owner, 5 Nov: the old "Lead Profile" box was too small to
work from).** Whenever a lead is on screen (`lead` state: preview pull,
ratio connect, manual dial, inbound, or wrap-up of any of those) the centre
column swaps "System & Queue Activity" for `LeadCardEditor`: every field
the lead carries (phone with local time from the lead's zone, list,
affiliate, posted, consent `consentJornayaId` / `consentTrustedFormId` /
`optInUrl` / `optInAt` / `optInIp`, attempts, last attempt and outcome,
owner, status, scrub badge, `custom`), with first/last name, email,
address, city, state, ZIP editable and a Notes box. The call panel still
sits above it during a call. Notes persist on the new `Lead.notes` column
(migration `20261105190000_lead_notes`). **Everything autosaves** (owner,
5 Nov: "they may forget to hit save"): fields and notes save one second
after typing stops and at once when the agent leaves the box (a disposition
click leaves it first); Save stays as a manual flush. Saves go through
`updateLead` (`actions.ts`) with no busy flag, failures show as a notice;
the save callbacks are read through refs because the console re-renders
every second for the clock. `updateLead` diffs against the
row and appends one `LeadEvent` NOTE with `changes: {field: {from, to}}`
plus the note text, so the history panel shows who corrected what.
`LeadCard` is built by `loadLeadCard` (one select, joins list → affiliate,
owner, last call); `nextLead` re-reads through it after the engine
reserves, so both paths return the same shape. The editor is mounted with
`key={lead.id}` so its form resets per lead instead of syncing state in an
effect (React Compiler rule). The left panel is now a compact summary
(name, phone, local time, Dial/Skip); Call Dispositions now lives under
the call controls (above). On the assist screen the current-lead row in
Lead Queue expands (`CollapsibleLeadCard`) to the same editor.

## Voicemail, recordings, DID hygiene (owner, 4 Nov)

- **Voicemail** per campaign: `voicemailAction` HANGUP (retry after
  `voicemailRetryMinutes`) or DROP; `voicemailMode` FILE (audio asset) or
  TTS (`voicemailScript` with {{first_name}}, {{last_name}}, {{company}},
  {{callback_number}}, {{agent}}; needs a speech vendor on the jambonz
  account). **Preview calls join the agent on answer, AMD on or off**
  (5 Nov: a 4 s hold for the AMD verdict was four seconds of dead air on
  every answered call, and jambonz sent no verdict at all); a later machine
  verdict pulls the call out of the room to the voicemail action. Agent button
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
  help reply. START lifts a STOP (or AI) entry. The owning agent gets
  `text:in` on the socket; the floor gets `floor:text`.
- **AI read of replies** (`apps/engine/src/sms/classify.ts`, 4 Nov): any
  inbound text that matches no keyword is classified with the Claude API
  (`@anthropic-ai/sdk`, structured output via `zodOutputFormat`, model
  `SMS_AI_MODEL`, default `claude-opus-5-5`) into OPT_OUT /
  CALLBACK_REQUEST / QUESTION / WRONG_NUMBER / INTERESTED / NOT_INTERESTED /
  OTHER with a confidence and a one-line reason, stored on `Message`
  (`intent`, `intentConfidence`, `intentReason`). Decision rules are pure
  and tested in `shared/sms.ts` (`decideReplyAction`, `callbackDue`):
  OPT_OUT at or above `SMS_AI_OPT_OUT_THRESHOLD` (0.8) is treated exactly
  like STOP (DNC source `AI_OPT_OUT`, leads closed, callbacks cancelled,
  confirmation text); below it the lead's `nextDialAt` is cleared and a
  NOTE event flags "possible opt-out" for a person; CALLBACK_REQUEST books
  a `Callback` (owner-scoped if the lead has an owner) at the time the
  person named in their local time zone, else in 15 minutes, clamped to the
  next two weeks. The classifier gets the last six texts of the thread for
  context and the lead's local time. `ANTHROPIC_API_KEY` unset or the API
  failing = keyword matching only, never a dropped message. Console: the
  `text:in` payload carries `intent` and `action`; the SMS thread shows the
  intent on each inbound bubble.
- Pre-call text, 4 Nov: the standard Fresh profile reads "your phone is
  going to ring within the next 30 seconds from {{caller_id_number}} … call
  that number back … Reply STOP if you'd rather not get a call";
  `instantDelaySeconds` is capped at 30 (default 15) in the engine and the
  form; `{{company}}` is a template variable (tenant name, cached per
  process). Migration `precall_text_30s` rewrote profiles that still had
  the original default text.
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
- A pacer call has `agentId null`. On answer `/jambonz/call` bridges at
  once with `bridgeToReadyAgent` (longest-idle READY agent claims the call
  atomically, `patchAgent ON_CALL`, conference join), or safe-harbor `play`
  + hangup and an `abandoned` ledger row. AMD keeps running on the leg; the
  AMD hook's reply **replaces** the current verb, so a machine verdict →
  the campaign's voicemail action even after the join. (Until 5 Nov the
  call was parked on a pause for the verdict; see the voicemail note above.)
- **Only the main console window has a phone.** The two-screen assist
  window (`/agent?screen=assist`) neither registers the softphone nor
  raises the line; Ready there says to use the main window. Until 5 Nov
  both windows registered, Ready clicked in the pop-up moved the line
  there (the engine hung up the main window's leg), and the browser
  blocked audio in a pop-up nobody had clicked in: silent calls.
- **One line per agent.** When a softphone calls in for a user whose
  `agentCallSid` is another live leg, `agentLegVerbs` hangs the older leg
  up first (a second tab or device in the same room plays the shared
  microphone back: "hearing myself" while Paused, 5 Nov). The room-`end`
  event for a replaced leg is ignored when its `call_sid` is not the
  current line.
- The conference, conference-exit and call-status hooks log their bodies
  (`"conference event"`, `"conference exit for a lead leg"`, `"call
  status"`): the first place to read when a call has no audio.
- Screener detection is on only when `SCREENER_STT_VENDOR` is set (the
  jambonz account must have that STT vendor): a `config.transcribe` runs
  on the first 12 s; a phrase match (`shared/compliance/screener.ts`)
  redirects the call to `/jambonz/screener`, which plays the message,
  bridges, or hangs up per `Campaign.screenerAction`.
- **Screener banner for the agent** (owner, 5 Nov: "pop up the thing and
  say SCREENER, give them a short script, then tell them to shut up and
  wait"). `/jambonz/transcript` marks the call (`screenerDetected`,
  `amdResult SCREENER`, `providerData.screenerPhrase/screenerText`) and,
  if an agent is already on it (preview, or bridged before the phrase
  landed), emits `call:update` with `screener: true, screenerPhrase` and
  leaves the call where it is (no redirect once bridged). Otherwise the
  redirect runs and the AGENT action's `bridgeToReadyAgent` carries the
  same fields; so do `leadCallAnswered` / `leadCallBridged`
  (`screenerFields` in `dialer/calls.ts`), so the console gets the flag
  on whichever event reaches it first. `amd_human_detected` after a
  screener keeps `amdResult SCREENER`, emits `call:update` with
  `human: true` and writes a NOTE `LeadEvent` "Screener: the person picked
  up". Console (`console.tsx`): amber SCREENER banner at the top of the
  call panel (and above the Script on the assist screen) with
  `Campaign.screenerScript` (campaign page, next to the screener action;
  null = `DEFAULT_SCREENER_SCRIPT` in `shared/scripts.ts`) rendered by
  `renderScript` (`{{agent}}`/`{{agent.firstName}}`, `{{company}}`,
  `{{first_name}}`/`{{lead.firstName}}`, …, the same renderer the Script
  panel now uses). Steps: say it → "Said it" click or 5 s → stay quiet
  (spinner) → "They picked up. Go." on `human: true` or 25 s later as the
  time fallback (AMD has usually already spoken before the screener is
  recognised, so there is no reliable human signal yet). "Said it" writes
  a NOTE `LeadEvent` (`screenerSaidIt`). Reload: `callScreener` restores
  the banner from the `Call` row. The call ending or a disposition clears
  it. **Data note**: the National Solar Resolutions campaign still has
  `screenerAction MESSAGE`; the owner switches it to "Hand the call to an
  agent" on the campaign page (no migration touches it).
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
batches of 1,000 with three requests in flight. The server side is
`intakeBatch`: one DNC lookup, one existing-phone lookup, one `createMany`,
one events insert, one counter update per batch (duplicate UPDATE/ACCEPT
rows are the only per-row writes). There is no file storage and no size
ceiling to hit; a `ListImport` row carries the counts. The posting API
still uses the per-lead `intakeLead`, which fires the cadence trigger.

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

## Deploys and open consoles (5 Nov)

A deploy changes every Server Action id, so an agent console or floor page
opened before it fails with "Server Action … was not found on the server"
on the next click (seen on the first test day). `lib/version.ts` exports
`BUILD_ID` (`RAILWAY_GIT_COMMIT_SHA`, else `.next/BUILD_ID`, else a
per-process id); `/api/version` returns it, and the agent and floor pages
pass it in as the `version` prop. `components/new-version.tsx` polls the
route every 60 s (and on tab focus) and shows a non-blocking "A new version
is ready — reload when you're between calls" banner with a Reload button;
the console's `run()` and the floor's `refresh`/`act` also turn the
"was not found on the server" error into that banner. The page never
reloads by itself: a reload drops the softphone line, so it must not happen
while the agent is ON_CALL or WRAP_UP, and the agent decides.

## Tests

`pnpm test` runs node:test suites. The compliance window tests
(`packages/shared/src/compliance/window.test.ts`) pin the rule semantics:
most restrictive wins, state attempt caps beat campaign allowances, Sunday
rules, the federal 8am floor. Add a test whenever a rule changes.
