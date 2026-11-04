# jambonz + Commio setup

What to configure in the jambonz portal (jambonz.cloud, account realm
`superdisa.sip.jambonz.cloud`) so Strowger can place and receive calls. The
engine's public URL is `https://engine-production-d809.up.railway.app`.

## 1. API key

Account → API keys → create one. Set it on the Railway **engine** service as
`JAMBONZ_API_KEY`. Without it the engine runs but reports
`telephony: false` on `/health` and refuses to dial.

## 2. Application

Applications → add application:

| Field | Value |
|---|---|
| Name | Strowger |
| Calling webhook | `https://engine-production-d809.up.railway.app/jambonz/call` (POST) |
| Call status webhook | `https://engine-production-d809.up.railway.app/jambonz/status` (POST) |
| Speech vendors | leave defaults; Strowger plays files, it never uses TTS |

Copy its SID to `JAMBONZ_APPLICATION_SID` on **both** Railway services. The
engine passes it on every outbound call and returns it from the registration
hook, so an agent's softphone dialling anything lands in our app.

## 3. Registration webhook (agent softphones)

Account → SIP realm / registration webhook:
`https://engine-production-d809.up.railway.app/jambonz/register` (POST).

jambonz forwards the digest from the phone; the engine checks it against the
agent's stored password and answers `{status: "ok", application_sid}`.
Agents are created on the People page; each gets a SIP username and a
password the browser uses automatically.

WebRTC endpoint for the browser: set `JAMBONZ_WSS_URL` on the **web** service
to the SBC WebSocket address shown in the portal (jambonz.cloud documents it
on the account page; it is of the form `wss://<sbc host>:8443`). Default in
code is `wss://sip.jambonz.cloud:8443`; correct it if the portal says
otherwise.

## 4. Carrier

The carrier is Telnyx (owner, 4 Nov): see `docs/TELNYX-SETUP.md`. The
Commio notes below are kept for a later second trunk.

### Commio (alternative BYOC)

Carriers → add carrier `Commio`:

- Outbound: Commio's SIP gateway host(s) and the trunk credentials from the
  Commio portal (IP auth or digest, as Commio provisions).
- Inbound: allow Commio's signalling IPs.
- Set `JAMBONZ_CARRIER=Commio` on the engine so outbound dials name the trunk.

Point the Commio DIDs you buy at the jambonz SBC (Commio portal → number →
route to SIP URI). In jambonz, Phone numbers → add each number, carrier
Commio, application Strowger, so inbound calls (callbacks to a local-presence
number) reach the engine. Add the same numbers under Strowger → Settings →
Caller ID numbers.

## 5. Webhook secret

Account → webhook secret. It is `JAMBONZ_WEBHOOK` on the engine. The engine
verifies `Jambonz-Signature` when present; set `JAMBONZ_REQUIRE_SIGNATURE=true`
once a live request has been seen with the header (check the engine logs).

## 6. Recording

Account → call recording → configure an S3-compatible bucket (Cloudflare R2
works) and "record all calls", or per application. Recording URLs are read
back from jambonz's recent-calls API in Phase 3.

## Variables, by service

Engine: `JAMBONZ_API_URL` (default `https://api.jambonz.cloud`),
`JAMBONZ_API_KEY`, `JAMBONZ_ACCOUNT_SID`, `JAMBONZ_APPLICATION_SID`,
`JAMBONZ_SIP_REALM`, `JAMBONZ_WEBHOOK`, `JAMBONZ_CARRIER`.

Web: `JAMBONZ_APPLICATION_SID`, `JAMBONZ_SIP_REALM`, `JAMBONZ_WSS_URL`.
