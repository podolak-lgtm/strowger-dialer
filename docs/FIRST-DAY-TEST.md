# First test day (owner: "start testing tomorrow")

What is wired, what to click, and what still needs a hand. Order matters.

## Before anyone logs in (30 minutes, you)

1. **jambonz portal** (account `superdisa.sip.jambonz.cloud`)
   - Application "Strowger" exists with the call and status webhooks
     (`docs/JAMBONZ-SETUP.md` §2). Health shows `applicationSid: true`, so
     the SID is set; confirm the webhook URLs point at the engine.
   - **Registration webhook**: `https://engine-production-d809.up.railway.app/jambonz/register`.
     Without it softphones cannot register and nobody can go Ready.
   - WebSocket address for browsers: the portal's SBC `wss://…:8443`; the
     web service's `JAMBONZ_WSS_URL` must match (default `wss://sip.jambonz.cloud:8443`).
2. **Strowger → Numbers → Run carrier setup.** Creates the Telnyx voice
   connection to the jambonz SBC, the messaging profile with our webhook,
   and the jambonz carrier "Telnyx" with its gateways. Read the result line
   on the page. If the jambonz portal's Carriers page shows a different SBC
   address than the account realm, set `JAMBONZ_SBC_FQDN` on the engine and
   run it again.
3. **Numbers → order** two or three local numbers in the area code you will
   dial, pinned to the test campaign. Then **DIDs → Register now** (needs
   the Free Caller Registry profile in Settings) or, to test today without
   waiting, **Mark all as registered**: numbers will not dial until they are
   marked.
4. **People**: one supervisor (you), two or three agents. Each person gets a
   SIP line when created; set a level (1 is fine; manual dial is on at
   every level). Add them to a team if you want the team-leader panel.
5. **Campaign**: status ACTIVE, preview mode first, dispositions (the
   defaults include a callback, a sale, a DNC and a voicemail code),
   allowed hours, caller-ID mode local presence. Assign the agents.
   Upload a small list of numbers you own (your mobiles). Set a script and
   a few rebuttals so the Assist panel has something to show.
6. **Texting**: 10DLC brand + campaign submitted on the Numbers page.
   Until the carriers approve (days), texts to real carriers may be
   filtered. Test texting last.

## The test (agents)

- Sign in at https://strowger.crossbar.digital: agents land on the agent
  screen. Pick the campaign, **Log in**, then **Ready**. The line badge
  should read "line up".
- Preview: a lead appears; **Dial**; answer on your own phone; hear the
  disclosure if on; disposition with a hotkey; wrap-up; next lead.
- Manual dial: type a number, dial.
- Leave voicemail & next; hold; transfer to a second agent; text the lead.
- Supervisor: Floor page → listen / whisper / barge on a live call.
- Team leader on the console: My Team panel, chat.
- Call back the number that called you: it should ring the agent who had
  the call (or their voicemail if nobody is free).

## Known gaps on day one

- **Recording**: jambonz call recording to the media bucket is configured in
  the jambonz portal (Account → recording); nightly export needs Settings →
  recording policy. Not blocking.
- **Reputation feed**: carrier spam readings are entered by hand until a
  vendor is connected.
- **Live transcript / sentiment**: waits on a speech vendor on the jambonz
  account; rebuttals and AI suggestions work without it.
- **Ratio dialing**: works, but run preview first; ratio needs several
  agents Ready to be meaningful.
- Expect a first-call bug or two in the jambonz hooks: keep the engine logs
  open (Railway → engine → logs) during the first calls.
