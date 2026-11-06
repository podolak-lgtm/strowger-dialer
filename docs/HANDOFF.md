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
  hangup. Outbound prompts are `play` verbs (no TTS on outbound). The inbound
  queue prompts (announcements, the callback offer, the survey, the default
  closed message) use `say` (6 Nov: the account has Cartesia); see
  "Inbound contact center" for the fallback.
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

### ACD (owner, 6 Nov: "the best at inbound, that's the future")

The gaps against an Automatic Call Distribution article, built in this
order. Pure maths in `packages/shared/src/inbound/` (`schedule.ts`,
`distribution.ts`, `geo-route.ts`, `metrics.ts`, each with tests); engine
in `apps/engine/src/inbound/` (`common.ts` shared verbs, `queues.ts` the
distributor, `callbacks.ts` virtual hold, `survey.ts`, `router.ts` entry and
IVR). Migration `20261106200000_inbound_acd`. Every queue setting is on
`/inbound` → Queues (one collapsible form per queue, sections Distribution,
Priority, Announcements, Callback, Blending, Limits, Survey); defaults
below are the column defaults.

1. **Hours and holidays**: `Schedule` (tenantId, name, timezone, `weekly`
   `{"1": [["09:00","17:00"]]}` Sunday = "0", `holidays` `[{date, name,
   audioId}]`, `closedNow` + `closedUntil` + `closedNowAudioId`,
   `closedAction` VOICEMAIL | IVR | QUEUE | MESSAGE (default MESSAGE =
   greeting then hang up) + `closedTargetId`, `closedGreetingAudioId`).
   Attached by `CallerIdNumber.scheduleId` (checked first, before any
   route) and `Queue.scheduleId` (checked on entry, also via IVR/overflow).
   `evaluateSchedule` is pure: ranges end-exclusive, end ≤ start = overnight
   (spills into the next day), "24:00" allowed, a holiday closes the whole
   local date, an unknown zone is closed. The holiday's or override's audio
   replaces the closed greeting; no audio = the spoken closed message.
   Admin: `/inbound` → Business hours (badge shows open/closed now; "Close
   now" button; "until" is typed in the schedule's own zone,
   `zonedTimeToUtc`). Closed → QUEUE recursion stops at depth 3.
2. **Strategy** `Queue.strategy`: LONGEST_IDLE (default) | ROUND_ROBIN
   (pointer `queue:<id>:rr` = last agent served; the rotation starts after
   it in user-id order) | FEWEST_CALLS (Redis hash
   `inbound:answered:<UTC date>`) | MOST_SKILLED (sum of levels on the
   required skills, then longest idle: what every skills queue did before;
   **the migration sets MOST_SKILLED on existing queues with skills** so
   they behave as before). `orderAgents` in shared. A queue with no skills
   still prefers its campaign's free agents.
3. **Priority**: caller priority = `priority` (0) + `vipPriority` (10) when
   `Lead.vip` + `knownLeadPriority` (2) when the number matched a lead, and
   +1 per `agingSeconds` (60; 0 = no aging) waited. The sorted-set score is
   `queueScore` = arrival − priority × agingSeconds (a point is worth that
   much waiting; without aging a point is worth 1e9 ms) so ascending score
   is exactly "highest effective priority, then arrival". The tick walks
   every waiting caller of the tenant across all queues in that order, so
   an agent qualified for several queues takes the highest-priority caller
   (`effectivePriority`). `Lead.vip`: supervisors toggle it on `/leads`
   (lead detail) and on the console lead card (★ VIP, `setLeadVip`); a
   NOTE LeadEvent records the change.
4. **Sticky** `stickySeconds` (20; 0 = off): on entry, when the lead's
   `lastAgentId` is logged in and qualified, `queued:<callId>` carries
   `stickyAgentId/stickyUntil`; until then only that agent may take the
   caller (others behind are not blocked), then normal distribution.
5. **Geographic routing**: `GeoRoute` (tenantId, name, `numberId` or
   `ivrId`, `states[]`, `areaCodes[]`, `targetQueueId`, `isFallback`,
   `sortOrder`). On a number the rules run after its hours and before its
   route; on an IVR they run for an option with action **GEO** (the
   option's own queue is the fallback when nothing matches). Area-code
   rules beat state rules; state = `resolveZone` on the lead's ZIP/state
   when we know them, else the caller's area code. The match is written to
   `Call.providerData.geoRoute`. Admin: `/inbound` → Geographic routing.
6. **Announcements** `announce` (off), `announceEverySeconds` (60, min
   15), `announcePosition`, `announceWait` (on): the waitHook returns a
   `say` ("You are second in line. Your estimated wait is about 3
   minutes.") on entry and then every N s, with the hold file played with
   `timeoutSecs` until the next one. Position = rank in our sorted set
   (callbacks ahead count). Estimated wait = mean gap between the queue's
   answers in the last hour × position (`queue:<id>:answers`, a sorted set
   of `<callId>:<wait>` by time); unknown → position only. **Speech
   fallback**: `say` carries `synthesizer` only when `TTS_VENDOR` (and
   optionally `TTS_VOICE`, `TTS_LANGUAGE` en-US) is set on the engine,
   otherwise the jambonz application's default speech vendor; a jambonz
   alert mentioning TTS/synthesis sets `tts:down` for 15 minutes, during
   which announcements are skipped and spoken prompts become silence (the
   survey is skipped). jambonz moves on to the next verb when a `say`
   fails, so the hold music still plays.
7. **Queue callback (virtual hold)** `callbackEnabled` (off),
   `callbackOfferAfterSeconds` (90), `callbackAudioId` (else spoken). The
   waitHook returns `leave` once the caller has waited that long (waitHook
   verbs may only be say/play/pause/leave, so the offer cannot be a gather
   there); the enqueue actionHook (`/jambonz/queue-exit`, `queue_result:
   leave`) answers with the gather; 1 → `/jambonz/queue-callback` creates
   `QueueCallback` (tenantId, queueId, phone, leadId, callerId = the
   number they called, score, priority, status WAITING | DIALING | DONE |
   FAILED, attempts), swaps the sorted-set member for `cb:<id>` at the
   **same score**, marks the call `outcome CANCELLED` "Asked for a queue
   callback" and thanks + hangs up; anything else re-enqueues at the same
   place. When `cb:<id>` comes up, the queue is open and an agent is free,
   `placeQueueCallback` checks the dial window (`evaluateDialWindow` with
   the caller's zone, the queue campaign's window or 8–21; no DNC check:
   they asked), reserves the agent (ON_CALL), creates an OUTBOUND `Call`
   with `queueId` and `providerData.queueCallbackId`, dials with tag
   `kind: qcallback`; `/jambonz/call` sends the answer straight into the
   agent's room. Not answered → the agent goes straight back to Ready, the
   callback goes back in line at its old score after 2 minutes; after 2
   attempts it is FAILED and a note (a `Voicemail` row with a transcript,
   no audio) lands in the queue's box. Outside calling hours it is looked
   at again every 10 minutes. The console shows "Queue callback for
   <queue>".
8. **Blending** `blendWaitSeconds` (30; 0 = never) and `reserveAgents`
   (0): every tick writes `blend:<tenantId>` (`blendHolds`): while the
   queue is open, all its qualified logged-in agents once the oldest live
   caller has waited past the threshold, else the first `reserveAgents` of
   them (free ones first). `pacingTick` leaves held agents out of `ready`
   (no new outbound for them, `PacingSnapshot.heldForInbound`); an
   already-answered pacer call still prefers non-held agents but takes a
   held one rather than abandon. Changes are logged ("Inbound priority:
   holding outbound for 3 agents") and shown on the floor wallboard. The
   cadence's instant dial on a posted lead skips held agents too; preview
   dialing is the agent's own click and is not held.
9. **Limits and wrap-up** `maxWaiting` (0 = no limit) with `fullAction`
   VOICEMAIL (default) | QUEUE (the overflow queue) | HANGUP (spoken busy
   message); `maxWaitSeconds` overflow as before. `wrapUpSeconds` (30;
   0 = until the disposition): when an inbound queue call (or a queue
   callback) ends the agent is WRAP_UP with `AgentLive.wrapUntil`; the tick
   moves them to READY when it passes (PAUSED when `afterCall` is PAUSED or
   the line is down), or, if they paused during wrap-up, leaves them paused
   and clears the call; the console gets `call:update {status: "wrapped"}`
   and clears the call panel. A queue with no campaign has no
   dispositions, so 0 there still means 30 s. A disposition ends wrap-up
   as before and writes `Call.wrapEndedAt`. `slaSeconds` (20) is the
   service-level target.
10. **Metrics**: `Call.queueId`, `queuedAt`, `waitSeconds`,
    `abandonedInQueue` (caller hung up while waiting: `leaveQueue(…,
    "hangup")`), `wrapEndedAt`, `surveyStartedAt`, `surveyScore`.
    Definitions in `shared/inbound/metrics.ts`: offered = INBOUND calls
    that entered a queue, except the one that asked for a callback (its
    callback leg counts when it connects); service level = answered within
    SLA over offered; ASA; abandon rate; AHT = talk (bridge → agent end or
    survey start) + wrap (→ `wrapEndedAt`); FCR = answered with no other
    inbound call from the number within 7 days; occupancy = (ON_CALL +
    WRAP_UP) / (READY + ON_CALL + WRAP_UP) from `AgentSession.events`; idle
    = READY time. Live: the tick writes `inbound:live:<tenantId>` (waiting,
    callbacks waiting, longest wait, qualified agents available / on call /
    wrap, open or closed), read through `/internal/inbound/live`. Floor:
    "Inbound queues" wallboard above both views (live + today's SL, ASA,
    abandon, AHT; the blending message top right), refreshed on
    `floor:queue` / `floor:blend`. Reports: Dashboard → **Inbound** tab
    (`/reports/inbound`, date range and queue filter; by queue and by
    agent) with `inbound.csv`, `inbound-queues.csv`, `inbound-agents.csv`
    from `/api/reports/[report]` (`lib/inbound-report.ts`). `tabOfPath`
    now picks the longest matching URL so `/reports/inbound` lights its own
    tab.
11. **Post-call survey** `surveyEnabled` (off), `surveyAudioId` (else
    spoken). **Not exercised on a live call: leave it off until a test
    call confirms it.** When the agent ends a bridged inbound queue call,
    `hangupCall` calls `startSurveyInsteadOfHangup`: `survey:<callId>`
    flag, `surveyStartedAt`, REST redirect of the caller's leg to
    `/jambonz/survey` (gather 1–5 → `/jambonz/survey-result` →
    `Call.surveyScore`), the agent to wrap-up at once and `call:update
    ended` (the caller's leg stays up, so no status hook does it). jambonz
    also runs the old room's conference actionHook after a redirect and its
    answer can win (the transfer race below), so `/jambonz/conf-exit`
    answers with the same survey verbs while the flag is set. What to
    check live: the caller hears the question once, the score lands, the
    call ends after the thanks.

**Redis keys** (all expire): `queue:<id>` (zset: callId or `cb:<id>`),
`queued:<callId>` (meta: queueId, at, priority, agingSeconds, leadId,
sticky), `qann:` last announcement, `qcboffer:` / `qcbprompt:` the offer,
`qbridge:<callId>` (agent being bridged: `/jambonz/queue-exit` answers with
the bridge if the enqueue's actionHook races the REST redirect, instead of
the old unconditional hangup), `qover:<callId>` (overflow verbs worked out
once so the redirect and the exit hook agree and one voicemail row is
made), `qcbwait:<id>`, `blend:<tenant>`, `inbound:live:<tenant>`,
`tts:down`. The `queues` job (1 s) does it all per tenant: wrap-up timers,
dead callers, overflow, the serving order, callbacks, blending, the live
snapshot.

Tested offline only (local engine, webhooks posted by hand): entry,
announcement, the callback offer → gather → callback row at the same
score, assignment to a Ready agent, wrap-up timer back to Ready, closed
schedule message, geo match to another queue, blending reserve. Not
verified against jambonz: that `leave` from a waitHook fires the enqueue
actionHook with `queue_result: leave` (the schema says so), the redirect
vs actionHook race on bridge and overflow, the survey (above), and Cartesia
speaking with no `TTS_VOICE` set.

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
  the console's `{{variables}}`. The campaign page's Script & rebuttals
  tab has a "Load script" / "Load rebuttals" picker in each card header
  (`campaigns/[id]/tab-script-games.tsx`): it fills the draft (confirming
  before it overwrites text); nothing is stored until Save campaign. The rebuttal card's
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
  (Games tab: bets go through Save campaign, see "Campaign page"; the poker
  run's Start/End are `campaigns/games-actions.ts`, immediate)
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
    - Cards and table: see **Seven-card stud and the run card (6 Nov)** below
      (it replaced the 5 Nov comic `PokerHand` / `RunLeaderboard`). Words and
      ranking are shared rules, tested: `cardLabel`, `describeHand` ("Two pair,
      kings and sevens", "Royal flush"), `handShort` (the pill), `handMakers`,
      `rankStandings`, `placeLine` ("You're 2nd of 6"), `timeLeft` ("2 days 5
      hours left"). A run's `winningHand.hand` is the described hand.
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
    - Look (bet board, purse, toasts): dark console with comic touches from the landing page (2px black
      outlines, hard drop shadows, `.sw-halftone` / `.sw-halftone-red` dots,
      the comic red `#c8472b` and cream `#f6efe0`). Keyframes are in
      `globals.css` (`sw-deal-*`, `sw-pop`, `sw-float-up`, `sw-toast-in`) and
      all switch off under `prefers-reduced-motion`. No sounds.
- **Seven-card stud and the run card (owner, 6 Nov: "Redo the game like
  this: 7 card, use this style graphics, more sexy!", with a phone mockup).**
  - Rules (`shared/games.ts`, tested): `HAND_MAX` = 7; `dealCard(held)` returns
    null at seven; `bestHand` already took the best five of any number (tests
    for six and seven cards, two trips, three pairs, kickers and ties).
    `rankStandings` orders by best hand, then cards held, then contacts; a
    place is shared only on a tie in all three (this is also how the run's
    winner is picked). `cardsEarned(outcomes, N)`, `cardProgress(outcomes, N,
    held)` (the ring: outcomes since the last card ÷ N, 0 when N = 1),
    `clampOutcomesPerCard` (1..100), `defaultOutcomesPerCard` (CONTACT 5,
    else 1), `outcomeNoun`, `handFullLine` ("Your hand is full: 7/7").
  - `PokerRun.outcomesPerCard Int @default(1)` (migration
    `20261106150000_poker_outcomes_per_card`; existing runs keep one card per
    outcome). Both run forms use `components/poker-run-fields.tsx`
    ("Deal a card every N <sales | live contacts | qualifying dispositions>",
    N follows the qualifier's default until typed). Posted as
    `outcomesPerCard` to `/internal/games/run`.
  - Dealing (`dealForOutcome`): on a qualifying disposition the engine
    **counts** the agent's qualifying calls in the run (calls of the campaign
    dialled before `endsAt` and dialled or ended after `startsAt`, whose
    disposition passes `earnsCard`) and deals until the hand holds
    `cardsEarned` cards. Counting, not a counter, so a re-disposition never
    double-deals. A full hand emits `games:full` (console toast) instead of
    `games:card`. Cards are dealt per player from their own deck (two players
    can hold the same card), as before.
  - `RunSummary` now carries `outcomesPerCard`, `handMax` and per row
    `contacts` (calls with an `isContact` disposition in the run window),
    `outcomes`, `progress` and `hand.short`. Rows include anyone with a
    contact or an outcome in the run, not only card holders (no cards ranks
    last).
  - Look: `components/poker-run.tsx` `PokerRunCard` (navy `#12142a`, dot
    grid, violet-to-gold glowing frame, "POKER RUN · 7 CARD STUD", time
    left, status pill, a 5-column grid of seven slots, locked slots with the
    violet progress ring on the next one, "Your Best Hand:" in gold, makers
    lifted with an amber glow, spare cards beyond the best five dimmed) and
    `PokerTable` (tabs THE TABLE: 1st/2nd/3rd gold/silver/bronze, initials
    avatar on a gradient with a ring in the place colour, hand pill, "n/7
    cards", contacts, the leader's row in a violet-to-gold frame;
    LEADERBOARD: the run's contacts with a bar, and past winners). Both use
    Tailwind container queries (`@container`, `@sm:`) so the same component
    fits the console's 320px column and `/games`. Used by the console Games
    panel and `/games` (managers who do not play see the leader's hand).
  - Card faces (`components/playing-card.tsx`): one 250 × 350 SVG per face,
    corners (rank over suit, the lower one turned), the classic pip layout
    for 2 to 10 (`PIPS`), a big ace, and our own double-headed court figure
    for J / Q / K (`CourtHalf`, red / blue / gold, crown, beard, sword,
    flower, cap; no copied card art). Sizes `sm` (simplified: rank and one
    pip) / `md` / `lg` / `fluid`. The deal overlay keeps the flip, restyled
    to the run card's look, and the dealt card also flips into its slot
    (`fresh`). Motion is `sw-*` / `motion-reduce:` so it stops under
    `prefers-reduced-motion`.
  - Checked locally (Playwright, seeded run, throwaway auth bypass not
    committed): `/games` at 1280 and 390 (no horizontal scroll; the campaign
    picker now shrinks), the console's Games column, the run form.
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

## Number planning and the pool (owner, 6 Nov)

Owner: "when a list is loaded into a campaign, work out the DIDs it needs,
tell the customer, and order and match them for local presence; DIDs start
in a pool, are registered to a campaign, go back to the pool when the
campaign dies; a flagged DID goes to the pool, not back to its campaign;
talk about returning pool DIDs idle two weeks."

- **The pool** is `CallerIdNumber.campaignId = null`. Numbers ordered on
  /numbers without a campaign land there (unchanged). `pickCallerId` already
  dialled from the campaign's own numbers plus the pool.
- **Planner** (`packages/shared/src/did-plan.ts`, pure, tested in
  `did-plan.test.ts`; assumptions in `PLAN_DEFAULTS`): dialable leads (NEW,
  IN_HOPPER, DIALING, CONTACTED, CALLBACK; not scrubbed DNC/litigator) are
  counted per area code (state = `stateForAreaCode`). Dials per lead on its
  day = the campaign's attempt rule (max of `maxAttemptsPerDay`, active dial
  plans' `attemptsPerDay`, the lists' cadence `maxAttemptsPerDay`) capped at
  **3**, because few leads use every attempt. The list is worked over **5**
  working days, so dials/day = leads / 5 × dials per lead. Numbers =
  ceil(dials / **75**) (`DID_RULES.establishedCap`) + round(20%) spare per
  area code, at least **1** spare in the whole plan (on the busiest row).
  Area codes under **25** leads a week fold into the busiest area code of
  their state. "Have" = pinned to the campaign, ACTIVE, not resting, not
  failed/released (unregistered numbers count, with a note: they need the
  Free Caller Registry before they dial). Pool: same area code first for
  every row, then same-state stand-ins unless **exact only** (forced when
  the campaign's `callerIdFallback` is EXACT_ONLY, since a stand-in would
  never be picked). Whatever is still short is ordered, sized for warm-up at
  **65** dials/day (the weeks 2–3 cap): a shortfall of n orders
  round(n × 75 / 65), never fewer than n. Price per number = platform
  `didMonthlyCents` × (1 + `didMarkupPct`) (cost for the platform
  workspace); the card shows the monthly cost of the new numbers and of all
  the campaign's numbers after applying.
- **Engine** (`apps/engine/src/provision/plan.ts`):
  `GET /internal/campaigns/:id/did-plan?tenantId&listId&poolFirst&exactOnly`
  (whole campaign = its ACTIVE lists; with `listId`, that list's leads
  against everything the campaign has, with a note that the campaign page
  plans all lists together) and
  `POST /internal/campaigns/:id/did-plan/apply {tenantId, userId, listId?,
  poolFirst, exactOnly}`: recomputes the plan, pins the chosen pool numbers
  (`updateMany` guarded on still being pool + ACTIVE; one taken meanwhile is
  ordered instead), then, if `outboundAllowed`, searches Telnyx per short
  area code and orders through `orderNumbers` pinned to the campaign; when
  Telnyx has too few in the area code it orders the rest in the same state
  and says so; what it could not find comes back in `short`. Pinning pool
  numbers is free and happens even when billing blocks the order (the
  result says "Nothing ordered: …"). Audit `numbers.plan.apply`. An archived
  campaign refuses.
- **UI**: `components/numbers-card.tsx` (client; loads through
  `numbers/plan-actions.ts`), with the table, the two options (pool first,
  exact area codes only), totals, monthly cost and one button "Take N from
  the pool and order M numbers" (confirm), or "You have enough numbers".
  It appears on the list page under the CSV import report when the list is
  in a campaign (keyed on `totalLeads`; the wizard calls `router.refresh()`
  after an import so it plans again), on the campaign's Dialing tab as the
  **Numbers** card with the numbers pinned to it (an immediate action, never
  part of Save), and in the **new campaign setup**: `createCampaign` now
  redirects to `/campaigns/<id>/setup` (step 2: upload a new list or attach
  an existing one, or skip; step 3: the CSV wizard and the numbers card).
- **Lifecycle**: archiving a campaign (save-all and the old
  `updateCampaign`) sets its numbers' `campaignId` to null inside the save
  (`returnNumbersToPool`; `campaign.save` diff `numbersToPool`); the Save
  confirm says so first. A flag or a rest (the reputation reading in
  `lib/did-reputation.ts`, /dids "rest", Settings status RESTING or
  SPAM_FLAGGED) also unpins the number, so it never returns to that
  campaign by itself. Scheduler job `restedNumbers` (10 min,
  `restoreRestedNumbers`) puts RESTING / SPAM_FLAGGED numbers whose
  `restUntil` has passed back to ACTIVE in the pool; a number still marked
  spam is flagged again by the next reading. Numbers set to SPAM_FLAGGED by
  hand without a `restUntil` stay out.
- **Idle pool numbers** (`isIdlePoolNumber`: pool, not RETIRED, no use in
  14 days, or never used and created 14+ days ago): job `idlePool` logs the
  count per workspace once a day; /numbers shows an "Idle in the pool 14+
  days" card with the monthly cost, checkboxes and "Release selected to
  Telnyx" (confirm, `releaseIdle` → `/provision/release` each, audit
  `provision.release_idle`). Nothing is released automatically. The numbers
  table shows a pool / campaign badge.
- **Local presence shortfall** (`Campaign.callerIdFallback`, Dialing tab →
  Caller ID card, in the draft): ANY (default, the old behaviour), SAME_STATE
  (only numbers in the lead's state, by area code), EXACT_ONLY (exact area
  code only; else the campaign's fixed caller ID if set, else null and the
  lead waits, with the reason logged). Pure scope in `callerIdFallbackScope`
  (tested). A lead's `assignedCallerId` from an earlier attempt still wins
  over `pickCallerId` in the pacer and cadence paths (unchanged).

## Email (6 Nov): sent through Crossbar

Strowger has no email provider of its own. `apps/engine/src/email/index.ts`
posts to Crossbar's agent API, `POST {CROSSBAR_URL}/api/agent/email` with the
same `CROSSBAR_AGENT_KEY` as the scrub; Crossbar sends through Resend from a
fixed "Strowger <strowger@…>" address on its verified domain (Crossbar's
`lib/agent/email.ts`: no from/cc/bcc/attachments, 10 recipients, 300 an
hour). Recipients are the workspace's active admins (supervisors if it has
none). Each message is sent once per key in Redis (`mail:<key>`), and a
failed send clears the key so a later run retries; email never blocks the
job that triggered it. Messages: trial ending (day 5, with the allowance
left), trial ended (unpaid), low balance (at or under the account's
warning level, once a day, not during a trial), outbound paused (suspended
after grace), and the monthly referral statement (one per referrer: each
referred client's credit or why not, clawbacks, "credit only, never cash").
Every send is audit-logged as `email.sent`.

## Referral program and free trial (owner, 6 Nov)

Owner: "Every client should get an invite link ... for a 1-week, 5-seat,
free, risk-free trial. If somebody signs up, the referrer gets a percentage
for life, but only while they stay a client too ... 5% (a $1,000 bill pays
out $50) ... Commission is a deduction from their bill, a credit ... we
never write out cash. Write the T&Cs."

**The terms pages are drafts: the owner's lawyer must review them and fill
in `[STATE]` before launch** (a code comment at the top of each says so):
`apps/web/src/app/legal/referral-terms/page.tsx` and
`.../legal/trial-terms/page.tsx` (public; the trial page carries the
platform usage terms at `#usage`: consent and TCPA compliance are the
client's). Their figures (rate, trial days, seats, allowance, numbers) are
read from `PlatformRates`, so they follow the settings. Versions are
`REFERRAL_TERMS_VERSION` / `TRIAL_TERMS_VERSION` in
`packages/shared/src/referrals.ts`: bump on a change in substance; a client
whose stored `referralTermsVersion` differs is asked to accept again before
the link shows (and a link whose referrer has not accepted reads "not
active").

- **Rules are pure** in `packages/shared/src/referrals.ts`, tested in
  `referrals.test.ts` (the owner's $1,000 → $50, the inactive-referrer case,
  clawback, lapse, one trial per business, self-referral, trial leftover).
  The engine (`apps/engine/src/referrals/index.ts`) only gathers figures and
  writes; every ledger line goes through `postEntry` in `billing/index.ts`.
- **Models** (migration `20261106180000_referrals_trial`). `Referral`:
  `tenantId` is the **referrer** (the tenantId rule: it owns the row),
  `referredTenantId` unique (a client is referred once), `source` link |
  platform, `code`, `lockedAt`, `endedAt` + `endedReason`.
  `Tenant.referredByTenantId` mirrors it (kept in step by attribution
  changes). `ReferralPayout`: one row per relationship and month
  (`@@unique([referralId, period])`), status CREDIT | FORFEITED, pct, base,
  credit, reason, clawback base and amount. `TrialClaim` (tenantId, business
  key, phone, email): every trial ever started, for one-per-business.
  Tenant gained `referralCode` (unique), `referralTerms*`,
  `referralPctOverride`, `businessPhone`, `trialStartedAt/EndsAt/
  ConvertedAt/ReminderAt/ClosedAt`, `trialSeats/MaxNumbers/AllowanceCents`
  (copied from the settings at sign-up), `trialTerms*`,
  `usageTermsAcceptedAt`, `closedAt` (no UI closes a workspace yet; when set,
  outbound refuses and the referrer's referrals end). `BillingKind` +
  `TRIAL_CREDIT`, `REFERRAL_CREDIT`, `REFERRAL_CLAWBACK`; `BillingCategory`
  + `TRIAL`, `REFERRAL`; `BillingEntry.uniqueKey` (unique, idempotency);
  `BillingAccount.suspendReason` BALANCE | TRIAL_ENDED; `PlatformRates`
  `referralPct` (5.00), `trialDays` 7, `trialSeats` 5,
  `trialAllowanceCents` 5000, `trialMaxNumbers` 3, `trialWithoutReferral`
  (false). Existing reports keyed on `kind: "CHARGE"` (revenue, statements,
  runway) are unaffected by the new kinds.
- **Link**: `/r/<code>` (8 characters from `REFERRAL_CODE_ALPHABET`, no
  0/O/1/I/L; made on the client's first visit to Refer & earn by
  `ensureReferralCode`) shows the landing page; "Start free trial" is
  `/r/<code>/start` (route handler) which sets `strowger_ref=<code>`
  (httpOnly, lax, 30 days) and 303s to `/sign-up?redirect_url=/onboarding`.
  **First referrer wins**: a cookie already holding another *valid* code is
  kept. `/r/(.*)` and `/legal/(.*)` are in the proxy's public matcher.
  Links use `WEB_PUBLIC_URL` (else `NEXT_PUBLIC_APP_URL`).
- **Sign-up** moved into the engine (`POST /internal/signup`, because the
  trial allowance is a ledger entry): onboarding reads the cookie, asks
  `GET /internal/signup/offer` what to show, and posts company name,
  business phone and the two acceptances. The engine: self-referral
  (`isSelfReferral`: the signer's business key matches any of the
  referrer's people, or the same Clerk user) → no attribution; a trial is
  offered when the link is valid and not self, or when
  `trialWithoutReferral` is on (**decision: off by default, so the trial is
  the referral offer**; tick it on /platform to give every sign-up a
  trial). One trial per business (`checkTrialEligible`): the business key
  (email domain, or the whole address for free mail in `FREE_MAIL_DOMAINS`,
  gmail dots and +tags folded) or the phone already on any user, any
  `Tenant.businessPhone` or any `TrialClaim` → refused with the reason; the
  page then offers "create a workspace without a trial" (dialing waits for
  a prepayment, as before). **A referral is recorded only for a business
  that gets the trial** (new to Strowger), so an existing client's second
  workspace never becomes someone's referral. Creates tenant, billing
  account, admin user, `TrialClaim`, `Referral`, audit rows, and a
  `TRIAL_CREDIT` of the allowance (`trial:<id>:grant`).
- **Trial limits** (while `inTrial`: started, before `trialEndsAt`, no
  payment yet): seats free (`chargeSeatIfNew` skips) and at most
  `trialSeats` different agents may log in (`trialSeatRefusal`, counted from
  `AgentSession` since the start; managers never count); `orderNumbers`
  refuses past `trialMaxNumbers` held numbers (so does the plan's apply,
  which orders through it); `sendSms` records a FAILED message and refuses
  (STOP/HELP replies still go: carriers require them); `outboundAllowed`
  refuses at once when the allowance is used up (no grace in a trial).
  **The first payment** (`recordPayment`, positive) sets `trialConvertedAt`
  (limits lift; seats are charged from the next agent login) and
  `Referral.lockedAt`. Job `trials` (15 min, `trialTick`): day 5 →
  `trialReminderAt` + audit `trial.reminder` (**in-app only: Strowger has no
  email path; the banner turns amber from day 5**); at `trialEndsAt` the
  unused allowance is removed (`trialLeftoverCents`: allowance less trial
  usage, never more than the balance; `trial:<id>:expire`), and an unpaid
  workspace is suspended with `suspendReason TRIAL_ENDED`: login, dialing,
  transfers and number orders answer "Your trial ended: add a prepayment to
  keep dialing." Nothing is deleted. Only a payment lifts a TRIAL_ENDED
  suspension (`afterBalanceChange({payment})`), never a credit landing.
- **Commission** (`computeReferralMonth`), per relationship per UTC month:
  rate = `Tenant.referralPctOverride` of the referrer, else
  `PlatformRates.referralPct`. Base = min(charges, money): charges = the
  referred client's CHARGE entries in the month posted after its trial was
  over (`trialOverAt` = first payment or end date); money = PAYMENTs in the
  month − refunds in the month (**every negative ADJUSTMENT counts as a
  refund**), floored at 0, + the positive balance carried in from real money
  (sum of entries before the month excluding TRIAL_CREDIT and REFERRAL_*).
  Credit = round(base × pct / 100): **$1,000 billed and paid at 5% = $50**.
  Both active or the month is FORFEITED (zero row with the reason, not
  banked): referrer not closed, not suspended at month end (suspended now
  with `suspendedAt` before the month end), a PAYMENT in the month or a
  positive balance at month end, and at least one SEAT charge in the month;
  referred not closed, not in trial at month end, not suspended at month
  end, charges > 0. An ended relationship forfeits. **Clawback**: refunds
  beyond the month's own payments take back earlier credit at the same rate,
  capped at the base credited before and not yet clawed back, posted as a
  negative `REFERRAL_CLAWBACK`, even in a forfeited or ended month. Single
  tier: only `Referral` rows count, nothing walks a chain.
- **Payout** = credit only: `runReferralCredits(period)` posts one
  `REFERRAL_CREDIT` per relationship on the referrer's account, note
  "Referral credit: <referred>, <period>, <pct>% of $<base>", key
  `ref:<referralId>:<period>:credit` (clawback `:clawback`), and the
  payout row; a second run skips (unique). It refuses a month not yet over.
  The ledger `period` of the entry is the month it was posted (so the
  billing page's "Referral credits this month" is what landed this month).
  Job `referralCredits` (first tick of each month, Redis key) runs the month
  before; /platform has "Run referral credits for <month>" (any finished
  month). Job `referralLapse` (daily, `endLapsedReferrers`): no PAYMENT or
  CHARGE on the referrer for 60 days (from creation for a new one), or
  `closedAt` → `endedAt` on every relationship where they refer, permanent.
- **Screens.** Client: **Refer & earn** (`/refer`, ADMIN/SUPERVISOR,
  a tab of the Billing section in `shared/nav.ts`, so `/billing?tab=refer`
  works too): the terms gate on first visit
  (`referralTermsAcceptedAt/Version/ById`, audit
  `referral.terms.accept`), then the link with Copy, an email and an SMS
  blurb, the program in three lines, totals, referred clients (name, joined,
  trial / active / inactive this month with the reason / ended, this month's
  estimate = the same computation up to now, lifetime credits) and the
  monthly statements. Billing: the trial notice, the TRIAL_ENDED notice,
  "Referral credits this month: $X", new kinds labelled in the ledger. A
  trial banner above every page for supervisors (`components/
  trial-banner.tsx`). Platform (`/platform#referrals`,
  `platform/referrals-card.tsx`): rate and trial settings, the month run,
  per-referrer override, every relationship (referrer, referred, since,
  status, last month's base and credit, lifetime) with **Change**
  attribution (refused once locked; audit `referral.attribution`) and
  **End** (with a reason; audit `referral.end`), and the trials list. All
  admin changes are audit-logged in the web actions
  (`lib/referral-actions.ts`), which call `/internal/referrals/*`.
- **Not built**: email for the day-5 reminder (no email path); a
  "close workspace" action (`closedAt` is honoured but only settable in the
  database); per-relationship rate overrides (the override is per referrer);
  automatic deletion of long-suspended trial data (the terms say data is
  kept). A trial workspace keeps being charged the monthly fee for numbers
  it holds after an unpaid end, like any client.

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
  page → **Transfers** tab: a compact table, a row opens the form in a side
  panel; add, edit, ↑↓ reorder, remove (a destination that has been used is
  deactivated, never deleted) and **Copy from campaign** (its active
  destinations; same names are skipped) all go into the draft and are
  written by Save campaign; **Deactivate/Activate** acts at once. `Transfer` gained `destinationId`, `destinationCallId`,
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
- **Console feedback** (5 Nov: Gage's first warm transfer was cancelled by
  his own second click, 1.7 s after Dial, because the console showed nothing
  until the engine's ringing event): Dial now sets a `pending` transfer at
  once ("Calling <name>…", pulsing dot, `Ns of 25` ring timer, "the lead
  hears the ring with you"), swapped for the engine's view when it arrives;
  **Cancel transfer** is greyed for the first 3 s after Dial and while the
  request is in flight. Connected shows green ("introduce them, then Leave"
  for warm).
- **Leave kept hanging up the lead** (6 Nov, Gage's warm transfer): Leave
  REST-redirects the lead to `/jambonz/xfer-join`, but jambonz still runs
  the old agent-room conference's `actionHook` (`/jambonz/conf-exit`) about
  0.2 s later, and its answer wins; it answered `hangup`, so the lead and
  then the destination (its room ends on exit) were hung up. `conf-exit`
  now asks `movedTransferFor(callId)` and, for a lead whose agent has left
  a live transfer, answers with `transferJoinVerbs(..., "lead")` instead.
  In the transfer room only the destination has `endConferenceOnExit`, so
  the lead joining twice (redirect, then exit hook) never ends the room;
  the lead hanging up for real still drops the destination through
  `endLiveTransfersForCall`.
- **Two buttons on a three-way**: "Leave call · they stay connected" and
  a red "End call for everyone" (asks first). The main End Call reads "End
  for everyone" while a transfer is live and is disabled after Leave.
  Dispositions refuse while a transfer is live (they hang up first) and no
  longer hang up after Leave.
- **Caller ID refused by Telnyx**: on 5 Nov Telnyx rejected the lead's own
  number as the `from` (SIP 403 to jambonz, CDR `CALL_REJECTED`, Telnyx
  error D51). The fallback redial from the campaign's number worked within
  0.4 s. Showing the customer's number needs Telnyx to allow non-owned
  caller ID on the account (a request to Telnyx support); until then every
  CUSTOMER-mode transfer falls back and carries `callerIdFallback`.
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

## Test phones: calling hours off for the owner's own numbers (6 Nov)

The owner asked for a 12-hour switch to test on his cell after 9 p.m.
Eastern. It is scoped, not a global off switch: `Tenant.settings.testPhones
= { phones, until }` (up to `TEST_PHONES_MAX` 10 numbers; `until` = now +
`TEST_PHONES_HOURS` 12). Rules and tests in
`packages/shared/src/compliance/test-phones.ts`; `evaluateDialWindow`
takes `testPhone: true` and then skips hour, weekday and attempt limits
(the time zone is still required). The engine asks
`dialer/test-phones.ts` `isTestPhone` (15 s cache) in `manualDial` and the
hopper's `eligibility`; texts (`cadence.ts`) keep normal hours, and DNC is
checked outside the window so it still applies. Settings → "Test phones:
ignore calling hours" (admins; audit-logged on and off) pre-fills the last
list, `DEFAULT_TEST_PHONES` (the owner's 561-271-8275 and 430-382-1338),
and every active transfer destination's number. Expired = off, no job
needed. **Always on** (owner, 6 Nov: "test numbers that can be called
anytime 24/7, that's fine") stores `{ phones, until: null, always: true }`
and stays on until an admin turns it off; the card's checkbox defaults to
it. It still covers only the listed numbers.

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
  then least used (the campaign's `callerIdFallback` decides how far it
  looks; see "Number planning and the pool"). Any spam/blocked reading →
  unpinned to the pool and SPAM_FLAGGED with a 21-day
  `restUntil`. Short calls (<10 s after answer) are counted per number
  (`shortCallsToday`). DIDs page shows all of it and bulk "mark registered".

## Campaign page: tabs and one Save (owner, 5 Nov)

`/campaigns/<id>` was ~5,200 px tall with 22 Save/Add buttons. It is now a
sticky header (name, status, stat line, "● Unsaved changes on N tabs",
Discard, **Save campaign**, Campaign builder) over nine tabs: Dialing,
Lists & dial plans, Compliance, Voicemail & screeners, Script & rebuttals,
Transfers, Dispositions, CRM push, Games. The owner's mockup
(`strowger-campaign-tabs-mockup.html`) never reached the repository; the
build follows the written spec. Each tab fits 1365×900 without scrolling;
nothing scrolls sideways down to 390 px (row tables stack as cards through
container queries, `@container` / `@min-[…]:`).

- **Files.** `campaigns/[id]/page.tsx` (server) only loads: the snapshot
  (`CampaignDraft`, values as the inputs hold them) plus read-only extras
  (list counts, webhook delivery state, script history, runs). Client:
  `editor.tsx` (reducer, header, tabs, save, guards), `editor-ui.tsx`
  (draft-bound inputs, error highlight via `data-field`), `tab-*.tsx`.
  Pure parts in `@strowger/shared`: `campaign-draft.ts` (tabs,
  `SETTING_TAB`, `dirtyTabs`, `removedIds`, `rebaseDraft`) and
  `campaign-form.ts` (every validation rule the per-section actions had,
  now shared by them and the single save; tested in
  `campaign-form.test.ts`).
- **Tab in the URL**: `?tab=compliance`; default `dialing`. Switching uses
  `history.replaceState` (no server round trip, no history entry).
- **Dirty tracking**: per tab, `dirtyTabs(snapshot, draft)` (JSON diff of
  the tab's slice); orange dot on the tab, red dot when Save returned an
  error there. Discard puts the snapshot back. When fresh server data
  arrives (after Save or an immediate action) `rebaseDraft` takes it for
  clean tabs and keeps edited tabs as they are.
- **One Save** = `saveCampaignAll` (`campaigns/save-all-action.ts`):
  validates the whole draft first (errors keyed `settings.name`,
  `dispositions.<rowKey>.code`, `transfers.<rowKey>.phone`, … with their
  tab; the page jumps to the first tab, opens the transfer panel if needed
  and focuses the field; the draft is kept), then writes everything inside
  one interactive `prisma.$transaction`: campaign settings, rebuttals,
  bets (with the switch-on top-ups), list attach/detach (`List.campaignId`),
  dial plans, dispositions, transfer destinations incl. order, webhooks,
  and a new `Script` version only when the text changed. Only rows that
  differ from the database are written. One `AuditLog` row
  `campaign.save` with the diff. Ctrl/Cmd+S saves; toast "Campaign saved".
  After the commit, if bets changed, the engine is told
  (`POST /internal/games/bets-saved` → `announceCampaignBets`: `games:bets`
  to the tenant, `games:points` to each topped-up agent); if the engine is
  down the save stands and the toast says the consoles were not told.
  Bet clamps and top-ups are `clampBetSettings` / `betTopUps` in
  `shared/games.ts`, used by the engine's own `setCampaignBets` too.
- **What changed in behaviour, deliberately**: rows are added and removed
  in the draft; a removed **disposition** that calls already used is
  switched off (`active false`, shown dimmed with "off ↺" to restore), an
  unused one is deleted; **webhooks** can be edited in place (URL, events,
  Active replaces Pause/Resume); **lists** can be attached (moves a list
  from another campaign; no job runs) and detached on the Lists tab.
  Rebuttals are still one JSON field (no versions); only the script keeps
  versions ("History (n)" loads an old one into the box).
- **Immediate, never through Save** (each confirms): the Dialing tab's
  Numbers button (take from the pool and order), poker run Start / End
  (`games-actions.ts`, redirects to `?tab=games`), transfer destination
  Deactivate/Activate (`toggleTransferDestination`; the editor patches both
  snapshot and draft so the tab stays clean), webhook Test.
- **Leaving with unsaved changes**: sidebar and in-page links are
  `components/nav-link.tsx` (Link + `onNavigate`, which is how Next 16
  cancels a client navigation) asking `lib/leave-guard.ts`;
  `beforeunload` for reload/close; Back is caught by a guard history entry
  pushed when the draft first turns dirty (`popstate` → confirm; Cancel
  re-pushes the entry at the current tab's URL).
- The per-section actions (`updateCampaign`, `saveDialPlan`,
  `saveDisposition`, `saveScript`, `saveRebuttals`,
  `saveTransferDestination`, `addWebhook`, …) still exist with the same
  rules (now via the shared helpers); the page no longer calls them.
- **App shell**: the sidebar is sticky at full height (its own scroll) and
  folds into a "Menu" under 768 px (see "Navigation" below); `main` is `min-w-0`, padding 16 px on
  phones. The client-workspace band carries `data-app-band` so the
  campaign header sticks below it.
- The app's `globals.css` still follows `prefers-color-scheme` for the body
  (a light-mode browser gets a white page around the dark cards); the
  campaign editor sets its own text colours so it reads either way.

## Navigation: launchers, sections, tabs (owner, 6 Nov)

"As few items on the left as possible, about 7." The menu is data:
`packages/shared/src/nav.ts` (`NAV_LAUNCHERS`, `NAV_SECTIONS`,
`visibleNav(viewer)`, `visibleTabs`, `tabOfPath`, `TAB_ALIASES`; tested in
`nav.test.ts`). Change the menu there, not in the layout.

- **Launchers** (top of the sidebar, sky outlined buttons with an
  open-in-window icon, not nav items): Agent console `/agent`, Floor
  `/floor`, Campaigns `/campaigns`. `components/app-nav.tsx` opens each in
  its own named popup window (`strowger-agent`, `strowger-floor`,
  `strowger-campaigns`) via `window.open("", name)`: an existing window is
  only focused, never reloaded (mid-call console, unsaved campaign); a new
  one is pointed at the URL. Inside the window of that name (the Campaigns
  window's own sidebar) it navigates in place. Popup blocked → opens in the
  same window. Middle / cmd / ctrl / shift-click fall through to the
  browser (the `<a>` has a real `href` and `target`).
- **Sections** (client admin sees 7: Dashboard, Leads, Numbers,
  Compliance, People, Billing, Settings; plus Platform when the owner is
  inside a client; Partner portal for affiliates):
  Dashboard = Overview `/dashboard` | Reports `/reports`;
  Leads = Find a lead `/leads` | Lists | Cadences | Affiliates;
  Numbers = Numbers `/numbers` | Reputation `/dids` | Inbound routing
  `/inbound` (also `/skills`) | Voicemails;
  Compliance (one page, no tabs); People = People | Teams & rooms | Games.
- **A tab is its own page at its old URL.** Each tab folder has a one-line
  `layout.tsx` rendering `components/section-shell.tsx` (server: the tabs
  this person may open) → `section-tabs.tsx` (client: links, active by
  `usePathname`, wraps on phones). Pages were not touched, so their own
  query params, server-action redirects and `revalidatePath` calls keep
  working, and sub-pages (`/lists/<id>`, `/people/<id>`) keep the bar.
  `?tab=` on a section root is an alias: `proxy.ts` redirects
  `/numbers?tab=reputation` → `/dids` etc. (`TAB_ALIASES`). Chosen over one
  page switching on `?tab=` because the pages' params collide and
  `revalidatePath("/dids")` would not refresh a page rendered at `/numbers`.
- **Roles are unchanged**: each tab carries the roles its page already
  required; a section shows if any tab does and links to the first visible
  one. A section whose only visible tab is not its own first page takes
  that tab's name (an agent sees Dashboard, Voicemails, Games and the
  Agent console launcher; agents opening /dashboard still land on /agent).
  The tab bar hides when one tab is visible. The bare platform workspace
  keeps Platform, People, Settings and no launchers.
- Active section is highlighted in the sidebar for any of its tab URLs.
- 390 px: the People, Teams, Compliance and Reports grids got
  `grid-cols-1` (their wide tables used to push the page sideways; they
  now scroll inside their card) and `PageHeader` actions wrap.
- The Campaigns window still carries the app sidebar (it is an `(app)`
  page); Agent and Floor are full-bleed `(console)` pages.

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
- **Agent states (owner, 6 Nov)**: log in → **PAUSED** ("Not ready yet");
  the agent goes Ready on purpose, pauses with a reason, and nothing dials
  for them otherwise. Ready with no line sets `AgentLive.readyOnLine`, and
  the line joining (`agentLegVerbs`) makes them READY; without that flag the
  line keeps their state (paused stays paused). A **manual dial** pauses a
  Ready agent first ("Manual dial") and sets `afterCall: "PAUSED"`; the
  disposition returns them to PAUSED, never READY, so the pacer (which only
  counts READY agents off a call: `readyAgents`) never dials behind a hand
  dial. A dropped line is PAUSED ("Line dropped"); LOGGED_IN is no longer
  set. The console asks for READY before raising the line.
- **A reload leaves a ghost line** (6 Nov, "I couldn't hear him"): the
  browser's half of the nailed-up leg dies with the page, but the engine
  still holds the old `agentCallSid`, so the next lead joins a room nobody
  hears. The console now hangs the leg up on `pagehide`, and once the
  softphone registers it raises a fresh line by itself when the engine
  says the agent is READY or PAUSED with a line this page does not own
  (the engine's one-line rule hangs up the stale leg). ON_CALL or WRAP_UP
  shows a notice instead, since a new line would end the room and drop the
  lead.
- **A reload mid-call keeps the lead card**: the console's restore-on-load
  path set the call but left the lead card empty (the lead only arrived with
  a later `agent:state` event). It now calls `leadForCall(currentCallId)`
  (`agent/actions.ts`, scoped to the agent's own calls) and shows it.
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
