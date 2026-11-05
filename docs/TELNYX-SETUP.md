# Telnyx as the carrier

Telnyx carries the calls (as a jambonz carrier) and the texts (directly,
through its messaging API). Nothing in Strowger names Commio; the engine's
`JAMBONZ_CARRIER=Telnyx` and `SMS_PROVIDER=telnyx` are already set on
Railway.

## The short version (4 Nov): do it from Strowger

With `TELNYX_API_KEY` and `JAMBONZ_API_KEY` on the engine, **Strowger →
Numbers** does steps 1 and 2 below for you ("Run carrier setup"), buys
numbers by area code for a campaign and registers them in jambonz, and
submits the 10DLC brand and campaign (step 3). The portal steps remain here
for reference and for checking what the setup created. The one thing to
verify in the jambonz portal is the SBC address Telnyx should send inbound
calls to (Carriers page); if it differs from the account's SIP realm, set
`JAMBONZ_SBC_FQDN` on the engine and run setup again.

## 1. Telnyx portal: voice

1. **SIP connection** (Voice → SIP Connections → Add): type *Credentials*
   is simplest. Note the username/password it generates. Set:
   - Inbound: SIP URI calling preference "SIP URI"; destination =
     the jambonz SBC. jambonz.cloud shows the SBC hostname on Account
     (it looks like `sip.jambonz.cloud` or a regional host); point the
     connection's "SIP subdomain / FQDN" routing at it, or use IP
     authentication with the jambonz signalling IPs listed on the same page.
   - Outbound: assign an **Outbound Voice Profile** (Voice → Outbound
     Voice Profiles) with your traffic type and a daily spend limit.
2. **Numbers** (Numbers → My Numbers): buy local numbers in the area codes
   you dial; for each, set the connection to the SIP connection above and
   the messaging profile from step 3. Remember the warm-up rules: a new
   number starts at 40 dials/day.

## 2. jambonz portal: carrier

Carriers → Add carrier → choose the **Telnyx** preset (jambonz ships one).

- Name: `Telnyx` (must match `JAMBONZ_CARRIER`).
- Outbound gateway: Telnyx's SIP host for your region (the preset fills
  `sip.telnyx.com`); auth with the credentials from step 1.
- Inbound: the preset lists Telnyx's signalling IPs; leave them.
- Phone numbers → add each Telnyx number, carrier Telnyx, application
  **Strowger**, so inbound calls reach the engine.

Then in Strowger → Settings → Caller ID numbers, add the same numbers and
mark them registered on the DIDs page once they are at the Free Caller
Registry.

## 3. Telnyx portal: messaging

1. **Messaging profile** (Messaging → Programmable Messaging → Add profile).
   Register a **10DLC brand and campaign** on it (required for US A2P;
   Telnyx walks through it; approval takes days, so start now).
2. On the profile, **Inbound settings → webhook URL**:
   `https://strowger.crossbar.digital/api/webhooks/sms/telnyx` (carrier setup
   on the Numbers page sets this on the profile it creates).
   Webhook API version v2.
3. Assign your numbers to the profile; tick **SMS-enabled** for them in
   Strowger → Settings → Caller ID numbers.

## 4. Keys, by service (Railway dashboard)

| Variable | Service | Where it comes from |
|---|---|---|
| `TELNYX_API_KEY` | engine | Telnyx portal → Account → API Keys (V2 key) |
| `TELNYX_PUBLIC_KEY` | web | Telnyx portal → Account → Public Key (used to verify inbound webhooks) |

Both are secrets: paste them in the Railway dashboard, not in chat.

## 5. Check

- Engine health `https://engine-production-d809.up.railway.app/health`
  shows `telephony: true, jambonzAuth: ok`.
- Send a text from the agent screen to your own phone; reply STOP, then
  START, and watch the Compliance page's DNC list.
- Place one preview call to your own phone from `/agent`.
