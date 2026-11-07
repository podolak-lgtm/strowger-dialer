"use client";

// Dialing, Compliance, and Voicemail & screeners: the campaign row's settings.
import { DEFAULT_SCREENER_SCRIPT } from "@strowger/shared/scripts";
import { formatPhone } from "@strowger/shared/phone";
import { NavLink } from "@/components/nav-link";
import { NumbersCard } from "@/components/numbers-card";
import { Card, Hint, SettingCheck, SettingInput, SettingSelect, SettingTextarea } from "./editor-ui";

export interface PinnedNumber {
  id: string;
  phone: string;
  areaCode: string;
  status: string;
  /** Resting until this day (YYYY-MM-DD), when it is. */
  restUntil: string | null;
  registered: boolean;
  provisionStatus: string;
}

export function DialingTab({ campaignId, pinned }: { campaignId: string; pinned: PinnedNumber[] }) {
  return (
    <>
      <Card title="Basics">
        <div className="space-y-2.5">
          <SettingInput k="name" label="Name" />
          <div className="grid grid-cols-2 gap-3">
            <SettingSelect k="status" label="Status">
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
              <option value="PAUSED">Paused</option>
              <option value="ARCHIVED">Archived</option>
            </SettingSelect>
            <SettingSelect k="dialMode" label="Dial mode">
              <option value="PREVIEW">Preview</option>
              <option value="RATIO">Ratio</option>
            </SettingSelect>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <SettingInput k="ratio" label="Ratio" hint="Lines per ready agent" type="number" step="0.1" min="1" />
            <SettingInput k="maxRatio" label="Max ratio" type="number" step="0.1" min="1" />
            <SettingInput k="wrapUpSeconds" label="Wrap-up (s)" type="number" min="0" />
          </div>
          <SettingSelect k="hopperOrder" label="Hopper order">
            <option value="LIFO">Newest first (LIFO)</option>
            <option value="FIFO">Oldest first (FIFO)</option>
            <option value="PRIORITY">By dial-plan weight</option>
          </SettingSelect>
          <SettingSelect k="listSelection" label="Lists of different priority" hint="Set each list's tier on its page.">
            <option value="STRICT_PRIORITY">Strict priority: tier 1 first, always</option>
            <option value="WEIGHTED_ROUND_ROBIN">Weighted round robin: 3 : 2 : 1 across tiers</option>
          </SettingSelect>
          <SettingCheck k="closersMayDial" label="Closers may switch outbound on for themselves" />
          <SettingInput k="callbackOwnerMinutes" label="Callback owner window (min)" hint="How long a callback waits for its agent before the campaign may take it." type="number" min="0" />
        </div>
      </Card>

      <Card title="Caller ID">
        <div className="space-y-2.5">
          <Hint>
            Numbers pinned to this campaign are ordered and registered on the{" "}
            <NavLink href={`/numbers/order?campaign=${campaignId}`} className="text-sky-300 underline">
              Numbers page
            </NavLink>
            ; they must be registered with the carrier and jambonz before the campaign dials.
          </Hint>
          <SettingSelect k="callerIdMode" label="Mode">
            <option value="LOCAL_PRESENCE">Local presence: rotate numbers matching the lead&apos;s area code</option>
            <option value="FIXED">One fixed number</option>
          </SettingSelect>
          <SettingInput k="fixedCallerId" label="Fixed number" hint="Fixed mode; in local presence, the fallback when Exact area code only finds nothing free." placeholder="(305) 555-0100" />
          <SettingSelect k="callerIdFallback" label="When no number in the lead's area code is free" hint="Local presence looks at this campaign's numbers and the shared pool, same area code first.">
            <option value="ANY">Use any free number (any area code)</option>
            <option value="SAME_STATE">Use a number from the lead&apos;s state only</option>
            <option value="EXACT_ONLY">Exact area code only: else the fixed number, else the lead waits</option>
          </SettingSelect>
        </div>
      </Card>

      <Card title={`Numbers (${pinned.length} pinned)`} className="min-[900px]:col-span-2">
        <div className="space-y-3">
          <Hint
            more={
              <>
                Numbers start in the workspace&apos;s shared pool and are pinned to a campaign by this button or on the Numbers page. Archiving the campaign returns them to the pool. A number that is flagged or put to rest leaves the campaign for the pool, and rotates back in from the pool when its rest ends. The button below acts at once (with a confirm); it is not part of Save campaign.
              </>
            }
          >
            What every active list on this campaign needs, by area code.
          </Hint>
          <NumbersCard campaignId={campaignId} />
          {pinned.length ? (
            <div className="flex flex-wrap gap-1.5 border-t border-zinc-800 pt-3">
              {pinned.map((n) => (
                <span key={n.id} className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${n.status === "ACTIVE" && !n.restUntil ? "border-zinc-700 text-zinc-300" : "border-amber-900 text-amber-300"}`} title={`${n.status.toLowerCase()}${n.restUntil ? `, rests until ${n.restUntil}` : ""}${n.registered ? "" : ", not yet registered at the Free Caller Registry"} · ${n.provisionStatus}`}>
                  {formatPhone(n.phone)}
                  {n.registered ? "" : " ·unreg"}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}

export function ComplianceTab() {
  return (
    <>
      <Card title="Calling window and attempts">
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-3">
            <SettingInput k="localWindowStart" label="Local window start (hour)" type="number" min="0" max="23" />
            <SettingInput k="localWindowEnd" label="Local window end (hour)" type="number" min="1" max="24" />
          </div>
          <Hint>Federal and state rules apply on top of this window; the most restrictive wins.</Hint>
          <SettingInput k="maxAttemptsPerDay" label="Max attempts per phone per day" hint="Dial plans may raise this per lead age, never above the state cap. Above 3 is flagged." type="number" min="1" max="10" />
        </div>
      </Card>

      <Card title="Abandons and recording">
        <div className="space-y-2.5">
          <div className="grid grid-cols-3 gap-3">
            <SettingInput k="abandonCapPct" label="Abandon cap %" type="number" step="0.1" min="0.5" max="3" />
            <SettingInput k="abandonWarnPct" label="Throttle from %" type="number" step="0.1" min="0.5" />
            <SettingInput k="abandonTimerMs" label="Abandon timer (ms)" type="number" min="500" max="2000" />
          </div>
          <SettingCheck k="recordingOn" label="Record calls" />
          <SettingCheck k="disclosureOn" label="Play recording disclosure when bridged" />
        </div>
      </Card>
    </>
  );
}

export function VoicemailTab() {
  return (
    <>
      <Card title="Answering machines">
        <div className="space-y-2.5">
          <SettingCheck k="amdEnabled" label="Detect answering machines" />
          <SettingSelect k="voicemailAction" label="On voicemail" hint="A machine is never handed to an agent in either mode.">
            <option value="HANGUP">Hang up and try again later</option>
            <option value="DROP">Leave a message, then try again later</option>
          </SettingSelect>
          <div className="grid grid-cols-2 gap-3">
            <SettingSelect k="voicemailMode" label="Message type">
              <option value="FILE">Recorded file (Settings → Audio)</option>
              <option value="TTS">Spoken script with variables</option>
            </SettingSelect>
            <SettingInput k="voicemailRetryMinutes" label="Retry after (minutes)" type="number" min="15" />
          </div>
          <SettingTextarea
            k="voicemailScript"
            label="Spoken script"
            rows={3}
            placeholder="Hi {{first_name}}, this is {{agent}} with {{company}} returning your request. Call us back at {{callback_number}}."
            hint={
              <Hint
                more={
                  <>
                    Variables: {"{{first_name}}"}, {"{{last_name}}"}, {"{{company}}"}, {"{{callback_number}}"}, {"{{agent}}"}. Needs a speech vendor on the jambonz account; otherwise use a file. Audio files for voicemail drop, screener message, safe-harbor and disclosure are uploaded under Settings → Audio.
                  </>
                }
              >
                Used when the message type is a spoken script.
              </Hint>
            }
          />
          <SettingCheck k="voicemailNotifySms" label="Text the agent when a caller leaves a voicemail in their box (each agent can switch it off for themselves)" />
        </div>
      </Card>

      <Card title="Call screeners">
        <div className="space-y-2.5">
          <SettingCheck k="screenerDetection" label="Detect call-screening services (Google Call Screen and the like)" />
          <SettingSelect k="screenerAction" label="When a screener answers">
            <option value="MESSAGE">Play the recorded name-and-reason message</option>
            <option value="AGENT">Hand the call to an agent</option>
            <option value="HANGUP">Hang up</option>
          </SettingSelect>
          <SettingTextarea
            k="screenerScript"
            label="Screener script for the agent"
            rows={3}
            placeholder={DEFAULT_SCREENER_SCRIPT}
            hint={
              <Hint
                more={
                  <>
                    Shown in a SCREENER banner on the console when a screened call is handed to an agent: they read it, then stay quiet until the person picks up. Variables: {"{{agent.firstName}}"}, {"{{company}}"}, {"{{lead.firstName}}"}, {"{{lead.lastName}}"}, {"{{city}}"}, {"{{state}}"}. Empty = the default shown here.
                  </>
                }
              >
                Read by the agent when a screener is handed to them.
              </Hint>
            }
          />
        </div>
      </Card>
    </>
  );
}
