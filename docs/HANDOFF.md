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
order. Pure maths in `packages/shared/src/inbound/` (`schedule.ts`, `hold.ts`, `ai.ts`,
`distribution.ts`, `geo-route.ts`, `metrics.ts`, each with tests); engine
in `apps/engine/src/inbound/` (`common.ts` shared verbs, `queues.ts` the
distributor, `callbacks.ts` virtual hold, `survey.ts`, `router.ts` entry and
IVR). Migration `20261106200000_inbound_acd`. Every queue setting is on
`/inbound` → Queues (one collapsible form per queue, sections Distribution,
Priority, Announcements, Callback, Blending, Limits, Survey, AI answer); defaults
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

12. **Forced hold** (owner, 6 Nov: "force hold time … if people hold 2
    minutes a good percentage fall off, which reduces customer service
    costs. It's just an option"). `Queue.minHoldSeconds` (0 = off, form
    max 600) and `minHoldBypassVip` (on): `enterQueue` stores
    `queued:<callId>.holdUntil` = the caller's **first** `queuedAt` +
    the hold (`forcedHoldUntil` in `shared/inbound/hold.ts`; an overflow
    into another queue does not restart it), and the tick does not offer
    the caller to any agent, sticky included, before it (`inForcedHold`).
    Sticky's window opens at the end of the hold. Announcements, hold
    music, the callback offer and overflow run as before; the form refuses
    `maxWaitSeconds` below the hold (`holdConflict`, the page shows the
    message via `?msg=`). No hold for VIP leads (when ticked), queue
    callbacks (their leg never enters a queue) and AI hand-offs
    (`enterQueue(..., { exemptHold: true })` or `providerData.aiHandoff`).
    `Call.forcedHoldSeconds` records the hold given; a hangup before
    `holdUntil` sets `Call.abandonedInForcedHold` as well as
    `abandonedInQueue`. **Metrics** (`summarizeInbound`, tested in
    `hold.test.ts`): `abandonedInForcedHold` and `forcedHoldDropPct`
    (of offered) on their own; `slaOffered` = offered − abandoned in hold
    is the base of service level and abandon rate (nobody was allowed to
    answer those callers); service level counts wait − hold ≤ SLA;
    `asaSeconds` and `longestWaitSeconds` stay total wait,
    `asaAfterHoldSeconds` is beside them. Report tile "Abandoned in forced
    hold", queue table column, CSV columns `forced_hold_seconds`,
    `abandoned_in_forced_hold`, `forced_hold_drop_pct`,
    `asa_after_hold_seconds`; wallboard "n in hold" under Waiting (live
    `inForcedHold`) and "+n in hold" under Abandon; the longest-wait colour
    turns red only past SLA + hold. **Blending** counts from the end of the
    hold (`oldestAnswerableWait`), so outbound is not held back for callers
    nobody may answer yet. Migration `20261106230000_queue_forced_hold`.
13. **AI answer** (owner, 6 Nov: "an AI answers for the queue, a built-in AI
    customer service that handles the call, with an option that if they
    say operator, manager or something like that, it transfers to a
    human"). **Built and checked offline; not yet on a live call: leave
    `aiEnabled` off on real lines until a test call confirms it.** Rules in
    `shared/inbound/ai.ts` (tested in `ai.test.ts`); engine in
    `apps/engine/src/inbound/ai/` (`control.ts` moving the call and
    finishing, `session.ts` the voice session, `tools.ts`, `llm.ts`
    summary and prompt test); migration `20261107000000_queue_ai_answer`.
    - **Settings** (`/inbound` → Queues → "AI answer"): `aiEnabled` (off),
      `aiMode` FIRST (every call, before the queue) | OVERFLOW (when the
      queue is closed, nobody qualified is logged in, or a caller past the
      forced hold has waited `aiAfterSeconds` (60, 0 = at once) with no
      qualified agent free; the form refuses `aiAfterSeconds` ≥ max wait)
      | ONLY (the AI handles everything; a person only on request). A
      closed queue with the AI on goes to the AI in every mode (a hand-off
      then meets the schedule's closed action). `aiGreeting`,
      `aiInstructions` (≤ 6,000 chars), `aiKnowledge` (pasted FAQ, kept in
      the prompt, ≤ 20,000), `aiHandoffPhrases` (default operator,
      manager, supervisor, human, agent, representative, real person,
      speak to someone), `aiMaxMinutes` (10), `aiSttVendor` /
      `aiTtsVendor` (blank = the account's: Deepgram first for
      speech-to-text, Cartesia first for speech), `aiVoice`, `aiLanguage`
      (en-US), `aiLlmVendor` (anthropic) and `aiModel`
      (`claude-sonnet-5-5`). **"Test the prompt"** (`ai-test.tsx`, server
      action `testAiPrompt` → `/internal/inbound/ai/test`) sends one
      caller line with the form as it stands (saved or not) to Claude, text
      only, with the same rules and tools, and shows the reply and any tool
      it would call; a hand-off phrase is reported as such.
    - **Refuses to turn on** unless the jambonz account can carry it
      (`aiReadiness`): jambonz configured, an https `ENGINE_PUBLIC_URL`, a
      speech-to-text vendor on the account (`GET
      /v1/Accounts/{sid}/SpeechCredentials`, `use_for_stt`; read by
      `jambonzAdmin.listSpeechCredentials`, which keeps vendor/label/use
      only and drops the keys the API returns), a speech vendor, and
      `ANTHROPIC_API_KEY` for anthropic. `saveQueue` saves everything else,
      leaves `aiEnabled` off and shows the problems ("…Account → Speech
      services → Add speech service → Deepgram…"); the AI section shows the
      same check on every page load. At call time `aiUsable` checks again,
      and `ai:down` (10 min, set when a redirect fails or the session never
      starts) sends callers to people.
    - **Transport (decision, 6 Nov).** The `agent` verb needs a WebSocket
      session; our application is webhooks. jambonz switches a live call's
      transport on a REST `call_hook` update: from an HTTP session an
      absolute `ws(s)://` URL on `session:redirect` makes a WsRequestor,
      hands the session over and sends `session:new` (feature-server
      `lib/utils/http-requestor.js`); from a WebSocket session an absolute
      `http(s)://` URL goes back to plain webhooks (`ws-requestor.js`). So
      **no second jambonz application**: entry returns `pause 5` + a
      `redirect` to `/jambonz/ai-fallback`, and 0.4 s later
      `jambonz.calls.redirect(sid, {url: wss://<engine>/ws/ai})`; if that
      never lands the pause ends on the fallback, which marks `ai:down`
      and queues the caller for people (`providerData.aiSkipped`). An
      OVERFLOW caller already in the `enqueue` is redirected the same way
      and only then leaves our sorted set; `/jambonz/queue-exit` answers
      `[]` while `ai:<callId>` exists so the enqueue's actionHook cannot
      undo the move. The `redirect` *verb* is not used for this: its
      absolute-URL branch keeps an HTTP requestor.
    - **WebSocket mount**: `@jambonz/sdk/websocket` `createEndpoint` answers
      every HTTP request with 405 and destroys any upgrade it has no route
      for, so it runs on a **detached** `http.Server`; `realtime.ts`'s single
      upgrade listener sends `/rt` to Socket.IO, `/ws/ai` to that endpoint
      (`handleAiUpgrade`), everything else to @fastify/websocket
      (`/audio/voicemail`). Checked: all three open, an unknown path is
      refused, also from the built `dist/index.js`.
    - **The session** (`session.ts`): call by `callsid:<sid>`, state
      `ai:<callId>`. `agent` verb: `stt {vendor, language, hints: the
      phrases}`, `tts {vendor, language, voice}`, `llm {vendor: anthropic,
      model, auth.apiKey: ANTHROPIC_API_KEY inline (AI_LLM_INLINE_KEY=false
      to use the LLM service saved in the jambonz portal instead),
      llmOptions {systemPrompt, maxTokens 300, temperature 0.4, tools}}`,
      `greeting` = `aiOpening` (a string: spoken as is, no LLM call; it
      always says "I'm an automated assistant"; the SDK's types still say
      boolean, the jambonz schema says boolean | string), `turnDetection
      krisp`, barge-in, the built-in `hangup` tool, `noResponseTimeout` 10
      × 2, toolHook `/ai-tool`, eventHook `/ai-event`, actionHook
      `/ai-done`. The system prompt is `aiSystemPrompt`: the **fixed rules
      first** (automated assistant, never claims to be human, never takes
      card / bank / SSN / passwords / codes, stays in scope, no invented
      prices or promises, transfer when stuck, short spoken answers, these
      rules beat the client's), then the business and line, the tools, the
      caller's local time, the client's instructions, the knowledge.
      Anthropic is a supported `agent` LLM vendor (jambonz docs: Bring Your
      Own LLM → Anthropic); the verb's minVersion is 10.1.0.
    - **Tools**: `transfer_to_human(reason)`; `lookup_caller` (by the
      caller's number: name, status, last disposition, upcoming callback;
      nothing else); `book_callback(local_time, note)` (`validateCallbackTime`:
      caller's zone from the lead or the area code, 5 min to 14 days out,
      8 am to 9 pm local; a `Callback` on the lead and the queue's campaign,
      AGENT scope for the lead's last agent or owner, lead → CALLBACK,
      `CALLBACK_SET` event with `source: ai`; an unknown caller becomes a
      lead in the campaign's "Inbound callers" list; no campaign = refused,
      offer a message); `take_message(message, caller_name,
      callback_number)` (a transcript-only `Voicemail` in the queue's box,
      `voicemail:new` to its owner).
    - **Hand-off** (`handOff`) on: a hand-off phrase in a `user_transcript`
      event (`matchHandoffPhrase`, whole words, before the LLM's reply plays),
      `transfer_to_human`, `aiMaxMinutes`, the agent verb ending for any
      reason but our hangup tool or silence, and the WebSocket dropping while
      the call is live. It finishes the AI part, sets
      `providerData.aiHandoff`, and REST-redirects the call to
      `/jambonz/ai-handoff`: "One moment while I connect you…" then
      `enterQueue(..., {exemptHold: true, priorityBoost: 100})` (the
      queue's own rules: hours, limit, sticky, announcements; no forced
      hold; never back to the AI: any `providerData.ai` blocks it).
      `finishAi` (once per call, `aidone:`) writes `Call.aiOutcome`
      RESOLVED (our hangup tool) | HANDOFF | MESSAGE / CALLBACK (a tool set
      it and nobody took over) | HANGUP (the caller hung up, or silence),
      `aiEndedAt`, `aiSeconds`, `aiTranscript` ([{role, text, at}] from the
      Redis list `aitx:<callId>`), a quick `aiSummary` ("Handed over: the
      caller said "operator". Last said: …"), then `writeSummary` replaces
      it with a Claude summary (`AI_SUMMARY_MODEL`) and pushes it to the
      agent if one is on. **Screen pop**: `assignCaller` adds `aiSummary`
      and the last 12 turns to `call:update`; the console shows a violet
      "AI summary: …" panel with "What was said" (`aiPanel`, both screens;
      a reload restores it through `callScreener`). `leadCallEnded` calls
      `aiCallEnded` so a caller who hangs up on the AI is finished.
    - **Costs** (`chargeAiMinutes`, after `finishAi`): `VendorUsage`
      jambonz `ai.minutes` (minutes × `PlatformRates.aiMinuteCostMillicents`,
      0 until the owner enters the jambonz speech cost on /platform), and
      the LLM as `ai.voice` through `recordAiUsage` with **estimated**
      tokens (`estimateAiTokens`: the agent verb calls the LLM inside
      jambonz, so no counts come back); the summary and the prompt test are
      `ai.summary` / `ai.prompt_test` with real counts. The client pays
      `BillingAccount.aiMinutePriceMillicents` per AI minute by the second
      (category `AI`, default 0 = not charged; /platform "AI answer
      ¢/minute"; shown on /billing when set), on top of talk time.
      `recordAiUsage` divided by 10,000 instead of 1,000,000 until 6 Nov:
      every AI cost on /platform was 100× too high; it now rounds to the
      cent per request.
    - **Metrics** (`summarizeAi`): handled, resolved, hand-offs, messages,
      callbacks, hang-ups, containment = (resolved + message + callback) /
      handled (a caller hanging up on the AI is not contained), AI minutes
      and the average, by `aiHandledAt`. Inbound report tiles (when any),
      an AI column per queue, CSV `ai_*` columns on `inbound.csv` and
      `inbound-queues.csv`; wallboard "AI" column (callers with the AI now,
      today's containment of handled). A hand-off caller entering the queue
      is offered there like anyone (its `waitSeconds` counts from that
      entry, not from the AI's start).
    - **What to check on the first live call**: the REST `call_hook` to
      wss lands and `session:new` arrives (engine log "AI session
      started"); the agent verb accepts the string greeting and anthropic
      with the inline key; Deepgram hears the caller; "operator" hands off
      and the agent's console shows the summary; the enqueue's actionHook
      after an OVERFLOW move does not win; `completion_reason` wording on
      `/ai-done` (hangup tool vs error) matches the regexes.

**Redis keys** (all expire): `queue:<id>` (zset: callId or `cb:<id>`),
`queued:<callId>` (meta: queueId, at, priority, agingSeconds, leadId,
sticky, holdUntil), `qann:` last announcement, `qcboffer:` / `qcbprompt:` the offer,
`qbridge:<callId>` (agent being bridged: `/jambonz/queue-exit` answers with
the bridge if the enqueue's actionHook races the REST redirect, instead of
the old unconditional hangup), `qover:<callId>` (overflow verbs worked out
once so the redirect and the exit hook agree and one voicemail row is
made), `qcbwait:<id>`, `blend:<tenant>`, `inbound:live:<tenant>`,
`tts:down`, AI answer: `ai:<callId>` (state), `aitx:<callId>` (transcript
list), `aidone:<callId>`, `ai:down`. The `queues` job (1 s) does it all per tenant: wrap-up timers,
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
  transcript-driven cues are built (6 Nov): see "Live transcription and
  agent assist".
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
    - **Bet board redrawn to the owner's mockup (7 Nov)**:
      `app/(console)/agent/bet-board.tsx` (`GamesShell`, `BetBoard`,
      `ChallengeCard`, `Coin`, `WinBurst`); `games.tsx` keeps the hook,
      purse, toasts and run. Games draws its own dark shell (blue "Games",
      "open ▾") instead of the console's `Panel`, so `console.tsx` did not
      change (the `Panel` prop is still accepted and ignored). Rows: two
      overlapping initial avatars, "You vs. Sarah M. (Who gets the next
      contact?)", a red clock and a coin with the stake; open bets in
      green-glow cards with "Take It"; challenges to me in violet with
      Accept/Decline (not in the mockup, kept); recently settled kept, short.
      CHALLENGE card: neon violet-to-blue frame, gold notches, dot texture,
      Who/On selects, gold coin slider (`.sw-coin-range`, track filled via
      `--pct`), trash talk 80 (the `Wager.note` that already existed; no
      migration), glossy red "PUT IT UP" (always that label), footer with the
      real `weeklyPoints`/`maxStake`. A win sets `useGames().win` and throws
      coins plus "+N pts" (N = both stakes, what is credited). Shared rules,
      tested: `periodEnd`, `betClock`, `initials`, `stakeRange`.
      **The clock**: bets have no deadline in the engine. A period bet
      ("most … today/week") counts down to the end of its UTC period; an
      instant bet ("next contact") settles on the next event, so its red
      clock counts **up** from when it was posted (blinking dot; `title`
      says "riding for …") — there is no `acceptedAt`, so it is time since
      posting, not since taken. CSS (`sw-bet-*`, `sw-coin-*`) is in
      `globals.css`, all off under reduced motion.
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
  (classify, assist) are costed from `res.usage` at the model's list price
  (Opus 5.5 $4/$20 per MTok, cache read $0.20, write $5; Sonnet 5.5 $2/$10;
  Haiku 5.5 $0.10/$0.50; the Sonnet and Haiku rows read $3/$15 and $1/$5
  until 6 Nov) into `VendorUsage` with the tenant. The scrub has no price API: rate only. `/platform` shows
  the Telnyx balance, vendor spend by kind, unattributed total, and a
  "pull last 7 days" button (`/internal/billing/vendor/sync`).
- **Accounting (owner, 6 Nov: "make sure all the APIs are grabbing
  everything … I'd like to know by client if we're profitable and that our
  margins are good")**. Superseded parts of the bullet above: the balance
  moved to `VendorAccount`, the job is now two jobs, and every cost (not only
  Telnyx and AI) is in `VendorUsage`.
  - **One cost model**: `VendorUsage` (migration `vendor_accounting`) has
    `costMillicents` (the figure every total uses; `costCents` kept rounded
    for old readers; an AI classification is a hundredth of a cent and used
    to round to 0), `source` and `updatedAt`. Sources: **api** (the vendor's
    records), **usage** (counted per event × list price or our rate),
    **estimate** (a call or text at our rate until its Telnyx record
    matches; `est:call:<id>` / `est:msg:<id>`, deleted on match, so no double
    count), **fixed** (entered on /platform). Every write goes through
    `keepUsage` keyed by (vendor, vendorRecordId); our own keys:
    `did:<numberId>:<YYYY-MM>`, `fixed:<costId>:<YYYY-MM>`,
    `invoice:<YYYY-MM>`, `ai:<callId>`, `stt.lead:<callId>`. The migration
    back-filled estimates, number rental and scrubs from `BillingEntry`.
  - **Each vendor's source**: Telnyx calls / texts / AMD, conferences,
    call control, recordings, media, STT/TTS, WebRTC = API (detail records,
    hourly), balance = API (`/v2/balance`, daily); numbers = usage (one row
    per Telnyx number per month at `didMonthlyCents`, to the tenant holding
    it, pool numbers included, `recordNumberCosts` hourly and at
    provisioning); 10DLC and Number Reputation fees = fixed, per client.
    jambonz.cloud plan = fixed, unless `GET /v1/Invoices` (the api-server's
    Stripe upcoming-invoice route) answers for our key and no jambonz fixed
    cost is entered, then the invoice is the month's cost (source api);
    `GET /v1/Accounts/:sid` gives the plan name. **Neither jambonz call has
    been seen working with our key**: the error, if any, shows on /platform →
    Balances. AI answer speech = usage (`aiMinuteCostMillicents`). Anthropic =
    usage per request (unchanged prices); with `ANTHROPIC_ADMIN_KEY` the
    Admin API cost report (`/v1/organizations/cost_report`, legacy Usage and
    Cost API, cents as decimal strings) gives Anthropic's own month total,
    shown for reconciliation only (it may include other usage on the same
    org). No API exposes Anthropic credit balance. Cartesia TTS = usage:
    an `onSend` hook on `/jambonz/*` counts the characters in each reply's
    `say` verbs (`spokenChars`), priced at `ttsCostMillicentsPerKChar`
    (default 4¢ / 1,000; jambonz caches repeated prompts so it errs high; set
    0 if a flat Cartesia plan is entered as a fixed cost instead). Live
    transcription STT = usage (`sttMinuteCostMillicents`). SubscriberVerify =
    usage (records × `scrubCostMillicents`). Railway, Clerk, Vercel = fixed
    until their connectors run (below). The Free Caller Registry is free.
  - **Fixed costs**: `VendorFixedCost` (vendor, kind, label, amount, MONTHLY
    or ONCE, start/end month, optional tenant). `materialiseFixedCosts`
    writes one row per month covered up to the current month (on save and
    hourly, so a new month appears by itself) and removes rows for months no
    longer covered or deleted costs. Seeded at $0 (not counted): jambonz
    plan, Railway, Clerk, Cartesia plan; the owner fills in the amounts.
  - **Attribution and allocation**: per call / text / number / AI request /
    STT / TTS / scrub to the call's or message's tenant; a fixed cost with a
    tenant is that client's. Shared = fixed costs with no tenant, and (when
    `allocateUnattributed`, default on) vendor usage that matched no tenant.
    **Rule**: `PlatformRates.costAllocation` MINUTES (default: billed talk
    minutes in the month) or SEATS (seats billed in the month; trial clients
    have none); largest-remainder split in `@strowger/shared/accounting`
    (`allocate`, `buildPnl`, tested); a client with no weight carries
    nothing, and what nobody carries is shown as "not carried by any client".
    The platform tenant's own costs (test calls, its numbers) are shown as
    its own line, never spread.
  - **Revenue** = the month's `BillingEntry` CHARGE total per client (what
    they were charged; trial usage included, flagged "trial").
  - **/platform** is tabs (`?tab=`): **Accounting** (top row revenue, cost =
    every vendor row in the month, gross margin, margin %; Profit by client,
    sortable client table `platform/pnl-table.tsx`, red under
    `marginFloorPct` (40) or a loss with no revenue; vendor table by vendor,
    kind and source for the month and the one before, "Sync now" =
    `/internal/billing/vendor/sync` = usage for 7 days + balances; Vendor
    balances with the last sync, any error, a warning line per vendor, and a
    typed balance for vendors with no balance API), **Clients** (balances,
    payments, open, new workspace, move campaign), **Costs** (fixed costs,
    allocation rule, margin floor, TTS rate, fallback rates), **Plans**,
    **Referrals**. A month picker (`?period=YYYY-MM`) sits beside the tabs;
    a low vendor balance warns on every tab. CSV: `/api/platform/export?
    what=clients|vendors&period=` (platform admins only; formula-safe).
    Engine: `GET /internal/billing/accounting`, `POST
    /internal/billing/fixed-costs`(`/delete`), `/accounting/settings`,
    `/vendor-account`.
  - **Jobs**: `vendorUsage` hourly (Telnyx records for 2 days, number
    rental, fixed costs), `vendorBalances` daily (Telnyx balance, jambonz,
    Anthropic report). A vendor that fails records `lastError` and does not
    stop the others. Not done: Telnyx invoices for number fees (numbers use
    the rate), referral credits as a cost line.
  - **Collection: connectors, buttons, nightly (owner, 6 Nov: "the APIs
    don't give you everything … a button next to it … at night you log in
    and get everything updated")**. `apps/engine/src/billing/vendors/`, one
    module per vendor with one interface (`types.ts`: `collect(ctx)` returns
    `{ balanceCents, reported, rows, invoices, note }` and writes nothing);
    the runner (`index.ts`) writes it all through the cost model:
    `VendorAccount` (balance, `balanceSource` api/portal, the vendor's own
    month figure), running month totals as `VendorUsage` keyed
    `period:<YYYY-MM>:<part>` (source api, `replace`, rows not returned again
    for a reported month removed), invoices through `invoice.ts`. Re-runs
    never add twice. The connectors:
    - **Telnyx** (API): wraps the existing detail-record pulls and balance;
      uses `TELNYX_API_KEY`, nothing to enter.
    - **Railway** (API, GraphQL `backboard.railway.com/graphql/v2`, account or
      workspace token as Bearer; schema read by introspection 6 Nov):
      `usage(workspaceId, month start→now, CPU_USAGE / MEMORY_USAGE_GB /
      NETWORK_TX_GB / DISK_USAGE_GB, groupBy PROJECT_ID+SERVICE_ID)` priced at
      the published rates (`RAILWAY_RATES` in `@strowger/shared/vendor-collect`:
      $0.000463 / vCPU-min, $0.000231 / GB-min, $0.05 / GB egress, $0.15 /
      GB-month volume) per service; `workspace.customer` gives `currentUsage`
      (their figure), `creditBalance` (balance) and `invoices` (paid/open:
      `total` taken as cents, PDF archived).
    - **Vercel** (API): `GET /v1/billing/charges?teamId&from&to` (FOCUS
      JSONL), summed per service and project for this month and last.
    - **Deepgram** (API, `Authorization: Token`, Administrator-role key):
      `/v1/projects`, `/balances`, `/billing/breakdown` (dollars). STT is
      already counted per minute, so Deepgram's dollars are reconciliation.
    - **Anthropic** (API): the Admin API cost report, reconciliation only as
      before; a key saved on the card wins over `ANTHROPIC_ADMIN_KEY`.
    - **Cartesia** (API, it has one): `GET api.cartesia.ai/usage/credits`
      with an admin key and `Cartesia-Version` (`CARTESIA_API_VERSION`,
      default `2026-08-14`; the docs index showed `2026-03-01` on one page).
      Credits are not dollars: shown as a note; cost stays per character or
      the plan.
    - **jambonz.cloud** (API + browser): `pullJambonz` as before, then the
      portal with the saved login for the subscription figure and past
      Stripe invoice PDFs.
    - **Clerk** (browser): the dashboard's billing page, upcoming figure and
      past Stripe invoice PDFs.
  - **Browser connectors** (`vendors/browser.ts`, Playwright Chromium, the
    image FCR uses): sign in with the saved username/password; a second
    factor is answered with a TOTP from the saved authenticator secret (RFC
    6238 in `@strowger/shared/totp`, RFC test vectors in its test; base32 or
    an `otpauth://` link) or an emailed code read from Crossbar's inbox
    (`GET /api/agent/inbox`, `vendors/inbox.ts`) at the saved "email code
    goes to" address, which must be one Crossbar receives. A CAPTCHA, SMS, a
    passkey or a device approval stops the run as **needs a person** with the
    reason. Each connector keeps its URLs and selectors in one object
    (`JAMBONZ_PORTAL`, `CLERK_PORTAL`); any failing step stores a full-page
    screenshot at `vendor-screens/<vendor>/<time>.png` and the card links it.
    **Neither portal has been signed in to from a session** (no logins here):
    the selectors are a best reading and the first live run is the test;
    Clerk's dashboard may well put a bot check in front of a headless
    browser, in which case upload its invoice instead.
  - **Invoices** (`vendors/invoice.ts`): a downloaded or uploaded PDF (a
    document block) or CSV (text) is read by Claude, `VENDOR_INVOICE_MODEL`
    (default `claude-sonnet-5-5`), through `client.beta.messages.parse` with
    a zod output format (vendor, invoice number, service period, currency,
    line items with description/quantity/amount, total) and the server-side
    refusal fallback (`fallbacks: "default"`). The read is costed as
    `ai.invoice`. Stored as `VendorInvoice` (unique on vendor + `ref` = the
    invoice number, else the month), file at
    `vendor-invoices/<vendor>/<period>[-<number>].pdf|csv`; the month is the
    middle of the service period (else a YYYY-MM in the file name). Lines
    become `VendorUsage` source **invoice**, keyed
    `invoice:<vendor>:<number or month>:<n>`, plus a "difference to the
    invoice total" line so the month equals the invoice. Reading it again
    replaces its lines.
  - **The no-double-count rule** (`@strowger/shared/vendor-collect`, tested):
    per vendor and month, month-level rows compete and only the best kind
    counts: **invoice > the API's running total (`period:` rows, and
    jambonz's `invoice:<YYYY-MM>` upcoming row) > fixed**. An invoice deletes
    that month's running total and `materialiseFixedCosts` skips (and
    removes) every fixed row of that vendor for that month; a running total
    skips the fixed row until an invoice arrives. Vendors counted per event
    (Telnyx, Anthropic, Deepgram, SubscriberVerify: `RECONCILE_ONLY`) never
    get invoice rows: their invoice is stored and its total shown as their
    figure for the month. Per-event rows are never touched by the rule.
  - **Credentials**: `VendorConnection` (migration `vendor_connections`, one
    row per vendor, platform-level like `VendorAccount`, so no `tenantId`):
    `sealed` = the credential JSON under AES-256-GCM with
    `VENDOR_SECRETS_KEY` (engine only; `vendors/secrets.ts`), `hints` = what
    the browser may see ("saved, ending …1234"; non-secret ids and emails in
    full). Blank fields keep what is saved; "remove the saved value" clears
    one. Every change is audit-logged as `vendor.credentials` with the field
    names, never values; also `vendor.nightly`, `vendor.collect`,
    `vendor.invoice-upload`. Without the key the card says so and the engine
    refuses to save. **Changing the key makes saved credentials unreadable**
    (the card shows the error): enter them again.
  - **/platform → Balances** (new tab; the Vendor balances card moved here):
    "Vendor connections" lists every connector with its method, what it
    collects, where to get the credential, the credential form, **Collect
    now** (background run; the card polls `vendorConnections` every 3 s for
    the live line: signing in… downloading… reading… done / failed with the
    reason / needs a person; last success time), **Upload invoice** (or drop
    a PDF/CSV on the row; route handler `/api/platform/vendor-invoice`,
    because Server Action bodies stop at 1 MB; capped at 9.5 MB because the
    proxy buffers 10 MB) and **Collect nightly**. Below it, the invoices
    read, with links through `/api/platform/vendor-file` (platform admins
    only). `/api/media` refuses `vendor-invoices/` and `vendor-screens/`
    keys (they are guessable). Engine: `GET/POST /internal/billing/connections`,
    `/connections/nightly`, `/connections/collect`, `/invoices/upload` (45 MB
    body limit for the base64 JSON).
  - **Nightly** (`vendorNightly` job, every 15 min, runs on the first tick
    at or after 07:00 UTC, the day marked before it starts): every connector
    with Collect nightly on, one after another; then the platform workspace's
    admins get one email (Crossbar, `vendor-nightly:<day>`) **only** when a
    run failed or needs a person, or a vendor balance is at or under its
    line (`nightlySummary`).
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

## Client onboarding wizard (owner, 6 Nov) — PAUSED, switched off

Owner: "When I set up a new client workspace I want it wizard-driven ... name
and email are the only minimum ... tell them about 7 days ... it ends with a
credit card." **Paused by the owner on 6 Nov** (merchant account about a week
away). Built and pushed, but **`ONBOARDING_WIZARD_LIVE = false`**
(`packages/shared/src/onboarding.ts`): nothing sends a client there by itself
(no first-visit redirect from /dashboard, no redirect after sign-up, no
"Finish setup" banner, no welcome email on workspace creation). `/welcome`
works when opened directly, from Settings ("Setup wizard") or from /platform
→ Clients → **Open wizard**. Turn the flag on only after the walk-through
below.

- **Rules, pure and tested**: `packages/shared/src/tendlc.ts` (10DLC brand,
  address, EIN, website findings, campaign checks; `toBrandInput` /
  `toCampaignInput` give the Telnyx shapes; `VERTICALS`/`USECASES` moved
  here from the Numbers page) and `onboarding.ts` (steps, status per step,
  progress, `TIMELINE_TEXT` and dates, `recommendedPrepayment`,
  `callingNotes` against `STATE_RULES`). Tests: `tendlc.test.ts`,
  `onboarding.test.ts`. **No 10DLC validation code existed before** (the
  earlier checks were done by hand in a session); these rules are new and
  are now also enforced by the Numbers page's brand/campaign forms
  (`numbers/actions.ts`; that form's free-text message flow skips the
  consent-wording checks), whose fields are prefilled from the wizard.
- **Data**: `Tenant.onboarding Json?` (migration `tenant_onboarding`;
  `onboarding_existing_clients` marks every workspace that existed before as
  finished, so live clients are never nagged). Shape `OnboardingState`:
  `steps.<you|business|texting|calling|leads|team|payment>`, `meta.<step>`
  (updatedAt, skippedAt), firstSeenAt, finishedAt, website (last check),
  registration, firstCampaign, reserve, paymentRequest. **Write only with
  `patchOnboarding`** (`packages/db/src/onboarding.ts`, one UPDATE per edit on
  a one- or two-key path) because the browser autosaves while the engine
  writes the same JSON. `packages/db/src/index.ts` now re-exports `prisma`
  from `client.ts`. Settings → Free Caller Registry profile is prefilled from
  the Business step (`fcrPrefill`); saved values win.
- **Web**: `app/(app)/welcome/` (`page.tsx`, `wizard.tsx` client,
  `actions.ts`). Left rail with dots (done / needs info / skipped / not
  started), jump anywhere, Back / Next / Skip, progress bar, why + "needed
  for" per step, the 7-day box with dates. Autosave = the console lead-card
  pattern (800 ms after typing stops, at once on blur or leaving the step,
  `saveStep`; no revalidation). The website check and the 10DLC status poll
  are **route handlers** (`/api/welcome/website`, `/api/welcome/registration`)
  because server actions run one at a time per browser and would queue
  behind autosave. Steps: You (name + email required); Business (live
  checks, website check 1.5 s after the address stops changing, "Ready for
  10DLC" list); Texting (compliant defaults prefilled, Submit only when
  clean, then status polled every 30 s); Calling (campaign name, hours,
  states checked against state rules, inbound, agent count); Leads (creates
  the first campaign, default "My first campaign", plus an upload list, then
  the existing `UploadWizard` and `NumbersCard` with `onApply` =
  `reserveNumbers` and the label "Reserve these numbers"); Team
  (`lib/people-invite.ts`, extracted from People: the user row with SIP and
  Clerk's invitation); Payment; Done. Also extracted: `lib/campaign-create.ts`.
  /platform → Clients has a **Setup** column (steps, 10DLC, payment, numbers
  waiting) and **Open wizard** (`openWorkspace` with `next=/welcome`).
- **Engine** (`apps/engine/src/onboarding/`): `website.ts` fetches the home
  page and the privacy page (public hosts only: every redirect hop is
  resolved and private / loopback / link-local / CGNAT refused; 8 s, 1.5 MB).
  `index.ts`: `submitRegistration` (re-checks, then `createBrand` +
  `createTenDlcCampaign` from provisioning; a campaign refused while the brand
  is unverified waits as `campaignPending` and job `onboarding10dlc` (30 min)
  retries it); `reserveNumbers` → `applyDidPlan`; with no funds the plan is
  saved (`reserve.state = pending_funds`) and **`onPayment`** (new listener
  hook in `billing/recordPayment`) orders it on the first payment, claimed
  atomically so it runs once; `startPayment`; `welcomeEmail` (button
  `/sign-up?redirect_url=/welcome`). Routes `/internal/onboarding/*`,
  `/internal/payments/provider`, `/internal/payments/webhook`. Audit:
  `onboarding.step.started|skipped`, `onboarding.tendlc.submit`,
  `onboarding.numbers.saved|reserved|ordered_on_payment`,
  `onboarding.payment.requested`, `onboarding.payment_link_needed` (on the
  platform tenant), `onboarding.finish`.
- **Payments** (`apps/engine/src/payments/index.ts`): `PaymentProvider`
  (`createSetupIntent` / `confirm` / `charge` / `webhook`) with `noneProvider`
  (default `PAYMENT_PROVIDER=none`). With none the Payment step shows "Card
  payments are being set up. We'll email you a secure payment link; you can
  also pay by wire or ACH" plus `PlatformRates.prepayInstructions`, and
  "Send me a payment link" emails the platform admins and audit-logs it.
  `recordPayment` gained `uniqueKey` (idempotent) and returns false on a
  repeat; `applyPaymentEvents` credits through it with key
  `pay:<provider>:<payment id>`.
  **To add a processor (likely Stripe)**: never collect or store card numbers
  in Strowger; use the provider's hosted checkout or hosted fields only.
  1. Write `stripeProvider` (see `TODO(provider)` in `payments/index.ts`):
     `createSetupIntent` = Checkout Session, mode payment, amount,
     `customer_email`, `client_reference_id` and `metadata.tenantId` =
     tenant id, success/cancel = the return URL,
     `setup_future_usage: off_session`, answer `{mode:"redirect", url}`;
     `confirm` = read the session (status only); `charge` = off-session
     PaymentIntent with the idempotency key; `webhook` =
     `constructEvent(rawBody, stripe-signature, STRIPE_WEBHOOK_SECRET)`.
  2. Events that credit `recordPayment`: `checkout.session.completed` with
     `payment_status = paid`, and `payment_intent.succeeded` (amount =
     `amount_received`, ref = the PaymentIntent id, so both events credit once).
     `setup_intent.succeeded` = card saved (no money). Refunds: post a
     negative `recordPayment` with key `refund:<id>` (counts as a refund for
     referral clawback).
  3. Env on the engine: `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`,
     `STRIPE_WEBHOOK_SECRET` (add to `config.ts`); on web nothing unless
     hosted fields are used (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, and the
     `embedded` branch in `wizard.tsx` PaymentStep).
  4. Webhook URL: `https://strowger.crossbar.digital/api/webhooks/payments/stripe`
     (public under `/api/webhooks/`; the route forwards raw body + headers to
     the engine, which verifies the signature).
  5. Return it from `paymentProvider()`; the Payment step then shows
     "Add a card and pay $X". Billing's own page still has no card button.
- **Recommended prepayment** = seats × the client's seat price + seats ×
  180 billed minutes a working day × 21 days × the per-minute price +
  planned numbers × the number price, rounded up to the next $100 (minimum
  $100). Seats = the most of: agents on the Calling step, agents invited, agents
  in People, 1.
- **Checked here**: shared tests; the engine routes by hand against local
  Postgres with no Telnyx or Crossbar keys (workspace creation prefill, the
  website check on example.com, nationalsolarresolutions.com and twilio.com,
  private addresses refused, Submit refused with every reason listed,
  reserve with no funds saved, a recorded payment picked up the saved plan
  (it then failed at the Telnyx search, as it must with no key), payment
  request audit, webhook 404 with no provider, `uniqueKey` crediting once).
- **Where it stopped / what remains before switching it on**: the wizard UI
  has **not been opened in a browser** (it typechecks, lints and builds; the
  pause came as the browser check started). Walk every step at 1280 and
  390 px; the CSV upload and Reserve inside the wizard; a real 10DLC
  submission with the owner (Telnyx brand fees apply; the campaign retry on
  an unverified brand is unproven); the welcome email through Crossbar and
  the Clerk sign-up redirect to /welcome; the platform payment-link email;
  the card processor itself. Then set `ONBOARDING_WIZARD_LIVE = true`.
  Known limits: the website check resolves DNS and then fetches (a
  rebinding race is possible; it only reads HTML and returns findings);
  10DLC resubmission after a rejection is by hand on /numbers; "Finish"
  only hides the banner.

## Media bucket

Railway bucket `media` (S3-compatible, region sjc). Vendor invoices and
failure screenshots live under `vendor-invoices/` and `vendor-screens/`,
which the public `/api/media` route refuses (see Billing, Collection). The web service reads
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

## One-way audio on the agent's line (owner, 7 Nov)

"I couldn't hear myself ... only one-way. Make sure it doesn't happen anymore." The engine log of the call
(16:29 UTC): the lead leg answered, joined the agent's room, and its speech was transcribed (`leg=lead`), so
the lead's side reached jambonz; the agent's side never did. Same shape as 6 Nov (lead transcribed, nothing in
the headset). Both with live transcription on, and an `no-stt` alert for **Cartesia** the same minute.

- **The agent's nailed-up line is never transcribed** (`AGENT_LEG_TRANSCRIPTION = false`, `assist/live.ts`).
  It used to get a transcribe `config` at line-up plus a REST `transcribe_status` pause/resume around every
  call: on the one leg every call's audio depends on. In two days not one `leg=agent` result arrived, so it
  never worked either. Only the lead leg is transcribed; assist works from the customer's words, and the
  console says "Only the customer is transcribed". Bringing the agent's side back must not touch that leg
  (e.g. dual-channel recognition on the lead leg); do not re-enable the flag.
- **AMD names its recognizer** (`amdRecognizer()`, used by `dialer/calls.ts` and `dialer/pacing.ts`).
  jambonz's AMD otherwise uses the application's default speech vendor, which on this account is Cartesia
  (voice only): every AMD call raised `no-stt`, the verdict never came (also why the 5 Nov 4 s hold waited
  for nothing), and the alert paused live transcription for an hour. No usable STT vendor = the call goes out
  without AMD.
- **An alert naming a voice-only vendor** (`TTS_ONLY_VENDORS`) no longer pauses transcription.
- **The console's audio watchdog** (`agent/audio-watchdog.ts`): while a call is up it reads the browser's
  WebRTC stats every 2 s. It unmutes a line still muted from the last call (the line outlives calls, and so
  did the mute), puts a fresh microphone on the line if the track ended, and otherwise says which side went
  quiet (`not-sending`, `not-receiving`, `mic-muted` by the OS or headset, `mic-silent` = exactly zero input)
  on screen. Each problem is one JSON line `agent audio problem` in the **web** service log with the call id,
  so the next report can be matched to what the browser measured.
- Not fixed here: jambonz's application default STT is still Cartesia in the portal. Set it to Deepgram
  (jambonz → Applications → the Strowger app → speech recognizer) so nothing else falls back to it.

## Live transcription and agent assist (6 Nov)

**6 Nov incident, and the guards it added.** Transcription was switched on
while the only speech service on the jambonz account was Cartesia (a voice
vendor). It was picked as the speech-to-text vendor; jambonz alerted
"speech to text credentials for cartesia have not been provisioned", the
lead and the agent never met in the room (no conference events at all), the
agent heard nothing, and jambonz then dropped the sessions without a final
status, so every Hang up failed with "call session is gone" and the console
stayed on the call. Now: (1) `TTS_ONLY_VENDORS` in `shared/assist/live.ts`
(cartesia, elevenlabs, playht, rimelabs, wellsaid, whisper) are never chosen
for transcription, tested; (2) a jambonz alert mentioning speech-to-text
(`no-stt` and the like) calls `markSttDown`, and `transcriptionReady` then
refuses for an hour, so new calls and agent lines come up without it;
(3) `hangupCall` treats "session is gone" / 404 from jambonz as the call
having ended and runs `leadCallEnded`, so the agent goes to wrap-up instead
of being stuck.

Both sides of a call transcribed live, coaching from what the customer says,
compliance checks on what the agent says, and an after-call summary.
**Built and checked offline against a fake jambonz; not yet on a live call.
Everything is off by default and calls are unchanged while it is off.**
Engine `apps/engine/src/assist/live.ts` (legs, hooks, state, compliance,
debounce) and `assist/coach.ts` (Claude); pure rules in
`packages/shared/src/assist/` (`match.ts` rebuttal matcher, `script.ts`
script steps, `live.ts` transcript caps, limits, readiness, notes; tested)
and `packages/shared/src/compliance/live-call.ts` (rules as data, tested).
Migration `20261107010000_live_transcription_assist`.

- **Legs (decision).** A Strowger call is two jambonz calls in one room
  (`agent-<userId>`): the lead's leg and the agent's nailed-up leg. Each is
  transcribed on its own with `channel: 1` (the leg's own voice) and labelled
  by leg: CUSTOMER from the lead's, AGENT from the agent's. Dual-channel on
  one leg was not used: jambonz's channel 2 on a conference member is what
  that member hears, i.e. the room's mix (the agent, plus a barging
  supervisor and a warm-transfer destination), and a leg carries one
  background transcribe. Two legs is simpler and labels itself.
  - **Lead leg**: `config.transcribe` (`interim: true`, `punctuation`,
    `channel: 1`, the account's STT vendor, `SCREENER_STT_LANGUAGE`) in the
    verbs that answer it: `leadAnsweredVerbs` (outbound, from the answer, so
    the first "hello?" is there) and `joinAgentVerbs` (inbound bridge, queue
    callbacks; now async). Hook `/jambonz/transcript?callId=&leg=lead`.
    **Screener detection shares it**: when live transcription is on for the
    call, its `config` replaces the screener-only one and the same hook runs
    the screener check on finals in the first 12 s (interim results are
    skipped there); with it off the screener path is exactly as before.
  - **Agent leg**: REST cannot start a transcription on a live call (only
    `transcribe_status: pause | resume`, SDK `rest-*.d.ts`), and the agent's
    leg is up all session. So `agentLegVerbs` prepends `config.transcribe`
    (hook `/jambonz/transcript?agentId=&leg=agent`) **only when the
    workspace has transcription on somewhere** (an active campaign or a
    queue, 60 s cache) and the account can do it; 3 s later it is paused
    (`transcribe_status: pause`). `leadCallBridged` → `liveCallBridged`
    resumes it for a transcribed call (`ltxa:<userId>` = the call it feeds),
    and `finish` pauses it when the lead leaves or the agent leaves. An
    agent whose line came up before the switch was turned on has no agent
    side until their next log in; the console says so
    (`transcript:status.message`). A result from an agent's leg with no call
    to feed is paused again (`ltxorphan:<sid>`); at the 40th such result
    `ltx:pause-broken` is set for 24 h and new agent lines start without
    transcription (logged as an error) so a pause that does not work cannot
    bill an idle line all day.
  - **Transfers**: external transfer Leave / cold auto-drop and the in-dialer
    closer transfer call `liveAgentLeft`: both sides stop (the lead's with
    `transcribe_status: pause` on its leg: nobody watches it after the agent
    leaves), the call is finished (summary, costs). While the agent is still
    in a warm three-way the lead keeps being transcribed; the destination's
    voice is not. A supervisor's barge is not transcribed either (their leg
    has none). Takeover: the agent's leg ends with its transcription; the
    lead's goes on to the call's new owner (the supervisor watches it).
- **Gate.** Campaign `transcriptionOn` (outbound, and inbound calls routed
  to a campaign), or Queue `transcriptionOn` for calls a queue hands to an
  agent (the queue's campaign supplies phrases, model and limits;
  defaults without one), **and** `transcriptionReady()`: jambonz configured
  and a speech-to-text vendor on the account, read with the AI answer's
  `speechCreds()` (`GET /v1/Accounts/{sid}/SpeechCredentials`,
  `use_for_stt`, cached 5 minutes) through `transcriptionReadiness` in
  shared: `SCREENER_STT_VENDOR` when set (it must be on the account), else
  Deepgram, else the first STT vendor. Not ready at call time = no verbs,
  a warning in the log, the call goes on. `GET /internal/assist/readiness`
  serves the web.
- **State**: Redis `ltx:<callId>` (settings snapshot, script steps, leg
  times, disclosure, assist budget; 6 h), `ltxt:<callId>` (finals, last
  400), `ltxleg:<userId>` (the agent leg carrying a transcription),
  `ltxa:<userId>`, `ltxorphan:<sid>`, `ltx:pause-broken`. Debounce timers
  are in the engine process (one engine).
- **Results.** Interim → `transcript:partial`, final → `transcript:final`
  `{callId, agentId, speaker, text, at}` to `agent:<agentId>` and to every
  supervisor listening to that agent (Redis set `watchers:<agentId>`,
  kept by `supervise/index.ts` on start / stop / leg end; team leaders'
  monitoring is the same supervision). Finals go to `Call.transcript` (JSON
  `[{speaker, text, at}]`, capped by `appendTurn`: 400 turns, 60,000
  characters, 2,000 per turn, oldest dropped).
- **Console** (`components/live-call.tsx`, `useLiveCall`): the "Communication
  & Live Transcript" box on the main screen is the live panel when the call
  is transcribed (otherwise "Live transcription is off for this call"):
  compliance banners, the assist cards, the chat-style transcript (customer
  left in cyan, agent right in violet as "You", interim words grey and
  italic until the final replaces them, follows the live end; scrolled up
  shows "Jump to live ↓"), the script checklist. The assist screen gets a
  "Live call" panel above the Script (transcript left, cards and checklist
  right). A reload or a late start reads the finals so far
  (`lib/live-call-actions.ts` `liveCallState`: the agent's own call, or
  any call in the workspace for managers). **Floor**: while a supervisor
  listens / whispers / barges, "Active Call Monitoring" shows the watched
  agent's live transcript (and compliance banners); "Call Supervision
  Console" lists the floor's live compliance alerts (`floor:compliance`).
- **Live assist** (`liveAssistOn`; needs transcription; queue
  `liveAssistOn` for queue calls). On each CUSTOMER final, debounced
  `ASSIST_DEBOUNCE_MS` 1.2 s (later finals within it are joined), skipping
  fillers (`isFiller`: under 3 words or only "yeah / okay / uh huh"…):
  1. `matchRebuttal` against `Campaign.rebuttals` (stemmed content-word
     overlap, the objection's exact words inside the utterance = 1, order
     bonus, negations kept; threshold 0.6) → `assist:rebuttal`, the green
     "Say this" card, at once, and no AI call.
  2. Otherwise, within `assistAllowed` (at most one every
     `assistMinGapSeconds` 8 and `assistMaxPerCall` 40 per call, clamped
     2–120 and 0–200; one in flight per call), `suggestNextLine`: Claude
     (`assistModel`, default `claude-haiku-5-5`, effort low) with structured
     output `{lines: 1–2, tone}`, **streamed**: `assist:suggestion`
     `thinking` → `streaming` (the lines as written, `partialLines` on the
     partial JSON) → `done` | `failed`, the blue "Suggested next line" card
     with the tone chip. System prompt (cacheable): the fixed rules (never
     invent facts, prices, savings, dates, guarantees or promises; only the
     script, the library or what the customer said; no pressure; a stop
     request is honoured; never the campaign's banned phrases), the script
     and the rebuttals; user turn: the lead (name, city, state, lead type,
     notes) and the last 12 turns. Usage → `recordAiUsage` `ai.live_assist`
     with the real counts; `Call.assistCalls` counts them.
  3. Script progress: `scriptSteps` splits the latest `Script` (Markdown
     `#`, `== HEADINGS ==`, ALL CAPS, `[Name]` or a short line ending in
     ":" start a step; numbered or bulleted lines are a step each; else
     blank-line paragraphs; up to 30 steps, 12 key words each, template
     variables removed); `coverSteps` ticks a step when the AGENT has said
     half of its key words (all of a one- or two-word step), in any order.
     `assist:script {steps, covered, next}` on bridge and when it changes;
     the checklist highlights the next step.
- **Compliance on the transcript** (`compliance/live-call.ts`,
  `LIVE_CALL_RULES`):
  - `disclosure_missing` (critical): when `spokenDisclosureRequired`
    (campaign page, off by default) and no `disclosurePhrases` (default
    recorded, recording, quality and training, monitored, transcribed;
    whole words) is heard in the agent's speech within
    `DISCLOSURE_WINDOW_SECONDS` (30 s) of the join, the red pulsing banner
    "Give the recording disclosure now"; it clears when heard later
    (`compliance:clear`). Not checked when the campaign plays its
    disclosure file before the join (`disclosureOn` + audio: the file is
    the disclosure) or when the agent's side is not transcribed
    (`disclosureState` "unknown": never an alert it cannot back).
  - `banned_phrase` (warning): every `bannedPhrases` hit in the agent's
    speech (new campaigns' column default and the tab's "Use the suggested
    list": guaranteed, free, no cost, risk-free), minus
    `BANNED_PHRASE_EXCEPTIONS` ("feel free", "toll-free", "are you free",
    "can't guarantee"…). Amber line on the console.
  - Each alert is appended to `Call.complianceAlerts` (last 50), a NOTE
    `LeadEvent` "Compliance: …", `compliance:alert` to the agent and
    watchers, and `floor:compliance` to the tenant.
  - **Two-party consent**: recording a call needs every party's consent in
    the all-party states (`ALL_PARTY_CONSENT_STATES`: CA, DE, FL, IL, MD,
    MA, MI, MT, NV, NH, OR, PA, WA; listed on the tab; to be confirmed by
    counsel like the state rules). Live transcription is a recording of the
    words for this purpose: a campaign dialling those states with
    transcription on should play the disclosure file or require the spoken
    disclosure. Nothing blocks a dial on it today.
- **After the call** (`finish`, on `leadCallEnded` or the agent leaving):
  the legs' seconds go to `Call.sttLeadSeconds` / `sttAgentSeconds`, costs
  are charged, then with `postCallSummaryOn` and/or `suggestDispositionOn`
  one Claude call (`summarizeCall`, the campaign's assist model,
  structured `{summary, disposition_code, reason}`, `ai.call_summary`
  usage) on the whole transcript (needs 2 turns). Summary: 3–5 sentences,
  stored on `Call.aiSummary` (an AI-answer call keeps its note first:
  "…\n\nCall: …") and appended to `Lead.notes` as "AI summary (6 Nov 2026
  14:05 UTC): …" (`aiSummaryNote`) with a NOTE event. The console's notes
  box takes the block in without losing what is being typed, and
  `updateLead` runs `keepAiSummaries` so an autosave from a box loaded
  before the summary never drops it (consequence: an AI summary block
  stays: deleted or edited in the console box, the stored block comes back
  on the next autosave; the agent's own text around it is theirs).
  Suggested disposition: the code matched to an active disposition of the
  campaign (`pickSuggestedDisposition`) → `Call.suggestedDisposition`
  `{dispositionId, code, label, reason}` and `call:summary` to the agent:
  in wrap-up a cyan line "Suggested: Not interested · reason" with
  "Confirm" and a ring on that button. Nothing is submitted until the
  agent clicks.
- **Settings.** Campaign page → new tab **Transcription & assist**
  (`tab-assist.tsx`, through the one Save; the keys are ordinary campaign
  settings in `campaign-form.ts` `parseAssistSettings`, phrase lists edited
  one per line): transcription on/off, after-call summary, suggested
  disposition, live assist on/off, model (Haiku 5.5 default, Sonnet 5.5,
  Opus 5.5), seconds between AI lines, AI lines per call, spoken disclosure
  required, disclosure phrases, banned phrases. The tab shows the account's
  STT vendor or what is missing. `/inbound` → Queues → "Live transcription
  and assist": transcribe calls, live assist. **Refusal**: switching
  transcription on (or assist on with it) asks the engine first; without
  an STT vendor Save returns the error on the tab ("Transcription was not
  switched on. The jambonz account has no speech-to-text vendor… In
  jambonz: Account → Speech services → Add speech service → a
  speech-to-text vendor such as Deepgram…, tick "Use for speech-to-text".
  Then save again."), the draft kept; the queue form saves the rest and
  says the same. Assist without `ANTHROPIC_API_KEY` is refused the same way.
- **Costs** (`chargeTranscription`): each leg's minutes as `VendorUsage`
  (vendor = the STT vendor, kinds `stt.lead`, `stt.agent`, tenant
  attributed) at `PlatformRates.sttMinuteCostMillicents` (/platform "Live
  transcription, ¢ per leg-minute", 0 until the owner enters it). The
  client pays, category `AI`, `BillingAccount.transcriptMinutePriceMillicents`
  per transcribed call minute (the lead leg's time, by the second) and
  `assistCallPriceMillicents` per AI suggestion, charged once per call at
  the end so fractions of a cent are not lost per request (/platform plan
  fields, shown on /billing when set; both default 0). LLM tokens: real
  counts per request via `recordAiUsage`. The screener-only transcription
  (transcription off) is not charged, as before.
- **Not verified live — the first-call checklist**:
  1. The agent's line comes up with the `config.transcribe` before the
     conference (engine log; the agent hears nothing different), and the
     3 s `transcribe_status: pause` is accepted (no "transcribe_status
     update failed" warning). Speak while Ready and idle: no
     `transcript:final` reaches the console, and the log does not show
     "agent transcription result between calls" repeatedly.
  2. On the bridge the `resume` lands and the agent's words arrive as AGENT,
     the lead's as CUSTOMER, **not mixed** (`channel: 1` is the leg's own
     voice; if the agent's words also show as CUSTOMER, the lead leg is
     transcribing the room mix: try removing `channel` from
     `transcribeVerb`).
  3. Interim results arrive (`is_final: false`) and the final replaces the
     grey text; Deepgram's latency is under a second or two.
  4. A screener on a transcribed campaign is still detected (the hook's
     screener check on finals).
  5. Hang up: both `pause`s are sent once, `Call.transcript` and the
     seconds are written, `VendorUsage` `stt.*` rows appear.
  6. With assist on and a key: say a library objection → green card at
     once; say something else → blue card streams within ~2 s; a summary
     lands in the lead's notes and the suggested disposition in wrap-up.
  7. A warm transfer: Leave stops both sides; the lead and destination
     keep talking.
  8. A supervisor listening sees the same transcript on the floor.
  The STT vendor's per-minute price goes into /platform before the first
  client is billed.

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
  open-in-window icon, not nav items): Agent console `/agent` and Floor
  `/floor` (owner, 6 Nov: Campaigns opening a window was a slip; it is a
  normal menu item again). `components/app-nav.tsx` opens each in its own
  named popup window (`strowger-agent`, `strowger-floor`) via
  `window.open("", name)`: an existing window is only focused, never
  reloaded (mid-call console); a new one is pointed at the URL. Inside the
  window of that name it navigates in place. Popup blocked → opens in the
  same window. Middle / cmd / ctrl / shift-click fall through to the
  browser (the `<a>` has a real `href` and `target`).
- **Sections** (client admin sees 8: Dashboard, Campaigns, Leads, Numbers,
  Compliance, People, Billing, Settings; plus Platform when the owner is
  inside a client; Partner portal for affiliates):
  Dashboard = Overview `/dashboard` | Reports `/reports`;
  Leads = Find a lead `/leads` | Lists | Cadences | Affiliates;
  Numbers = Numbers `/numbers` | Order `/numbers/order` | Texting
  `/numbers/texting` | Carrier setup `/numbers/carrier` | Reputation `/dids` |
  Inbound routing `/inbound` (also `/skills`) | Voicemails;
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
- Agent and Floor are full-bleed `(console)` pages; Campaigns is an
  ordinary `(app)` page in the main window.

- **Default page layout (owner, 7 Nov).** A page with three or more
  independent parts gets tabs: **one row only**, the section's bar, each
  tab its own URL (a sub-route such as `/numbers/order` added to `nav.ts`
  with the page's roles; the longest URL wins in `tabOfPath`, so the
  section root stays its own tab). Never a second tab bar under the
  section's, never a long stack of cards. A settings form spread over tabs
  gets a single Save with per-tab unsaved dots, as on the campaign page. A
  page whose job is one table stays one page. Each tab should fit
  1365×900 where it can; nothing scrolls sideways down to 390 px (row
  tables become stacked cards via `@container` / `@min-[…]:`). A section
  can show a short status line above its bar on every tab
  (`components/section-status.tsx`, database only, no engine call) and a
  mark after a tab label (`marks`, e.g. Carrier setup ✓); only Numbers has
  one so far.
- **Numbers split (7 Nov).** `/numbers` was six stacked cards. Now:
  Numbers (inventory table, stacked cards under 760 px of card width, plus
  the idle-in-the-pool card folded into a `<details>` with release),
  Order (search and buy, "Plan numbers for a list" = the same
  `NumbersCard` as the list page, picked by `?plan=<listId>`, and the
  order history), Texting (10DLC brand + campaign, unchanged forms),
  Carrier setup (✓ in the tab when the tenant has the Telnyx connection,
  jambonz carrier and messaging profile ids). Status line: numbers (pool),
  pending orders, `tenDlcStage` (shared/tendlc.ts, tested), carrier ready;
  shown only to people who can open the inventory tab. Shared bits in
  `numbers/parts.tsx`. Actions are the same; each now redirects back to its
  own tab (`backTo(tab)` in `numbers/actions.ts`) and revalidates the
  `/numbers` layout so the status line refreshes. Old links:
  `/numbers?campaign=…` / `?areaCode=` / `?qty=` redirect to
  `/numbers/order` with the same params (the campaign page link now points
  there directly; Reputation's "Order & provision numbers" too);
  `/numbers?tab=order|texting|carrier` work through `TAB_ALIASES`. The
  wizard's Done step, the onboarding email and Settings still say
  `/numbers` (the inventory), which is right.
- **Next long stacks to convert** (not done): Settings (10 cards: one form
  over tabs + single Save), Platform (11 cards), Inbound routing (6),
  Compliance (5), Billing / Refer & earn, the list page (`/lists/<id>`, 6).

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
- **Main screen layout (owner, 6 Nov)**: left column = Lead Profile, then
  Call Dispositions (a smaller box, two buttons a row, only on a call or in
  wrap-up); middle = Call in Progress, SMS, the full Lead card, Live
  Activity Feed, Lead history; right = team, assist, chat, games, sprint.
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

## Check a number (Compliance, 6 Nov)

Compliance → "Check a number" (supervisors) posts to
`/internal/compliance/check` (`apps/engine/src/scrub/check.ts`): our
`DncEntry` rows for the number (workspace and campaign), up to 10 leads with
it and their scrub status, then `crossbarScrub([phone], paid)` (Crossbar's
DNC, the licensed TCPA Litigator List, the cache, and SubscriberVerify when
"paid" is ticked, which is charged as one scrub). Verdict: BLOCKED (any hit),
CLEAR (Crossbar answered and nothing hit), UNKNOWN (Crossbar unreachable, or
the free lists had nothing and the paid lookup was off). Audit-logged as
`compliance.check-number`. The engine holds `CROSSBAR_AGENT_KEY`, so the
check never needs the key in a browser or a chat.

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
