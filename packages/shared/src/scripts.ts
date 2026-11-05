// Script template library (owner, 5 Nov). Starting points a supervisor
// loads into a campaign's "Agent script" card and edits before saving.
// Bodies use the console's variables: {{first_name}}, {{last_name}},
// {{agent}}, {{company}}, {{city}}, {{state}}. Each template also carries
// the rebuttals it refers to, in the campaign rebuttal format
// ("objection | what to say"), so the same loader fills that card too.

export type ScriptTemplate = {
  /** Stable id, used as the select value. */
  key: string;
  /** What the supervisor sees in the picker. */
  name: string;
  /** The script body, with {{variables}}. */
  body: string;
  /** Objection / response pairs that belong with the script. */
  rebuttals: { objection: string; response: string }[];
};

export const SOLAR_EXIT_REBUTTALS: ScriptTemplate["rebuttals"] = [
  {
    objection: "Not interested",
    response:
      "Totally fair, {{first_name}}. The only reason I'm calling is the form you sent us about your solar agreement. If that's been sorted out, I'll close it out and we're done. If it hasn't, two quick questions tell me whether we can even help. Which is it?",
  },
  {
    objection: "How did you get my number",
    response:
      "You, or someone at this number, filled out a form online asking for help with a solar lease or loan, and that's the only reason I have it. If that wasn't you, say the word and I'll take you off our list right now.",
  },
  {
    objection: "Send me something",
    response:
      "Happy to. So I send the right thing and not a brochure, is it the payment, the contract, or the system itself that's the problem? Also, is this the best number and email for you?",
  },
  {
    objection: "I'm busy",
    response:
      "No problem, I'll be quick. Is later today or tomorrow better? I'll put you down for that time so you're not chasing us.",
  },
  {
    objection: "Can you get me out of it / guarantee it",
    response:
      "I can't promise an outcome, and I'd be wary of anyone who does. What I can do is get a specialist to look at your actual agreement and tell you honestly what your options are. Does that sound fair?",
  },
  {
    objection: "Stop calling me",
    response:
      "Understood. I'm adding this number to our do-not-call list right now and you won't hear from {{company}} again. Sorry for the bother, {{first_name}}.",
  },
];

export const SOLAR_EXIT_SCRIPT = `SOLAR EXIT — FRONTER SCRIPT ({{company}})
Goal: confirm the request, qualify in 3 to 5 questions, warm-transfer to a closer. No promises, no guarantees. If they say stop calling, stop and disposition DNC.

== OPENER ==
Hi, is this {{first_name}}? ... {{first_name}} {{last_name}}?
Great. {{first_name}}, this is {{agent}} with {{company}}. I'm following up on the request you sent us online about your solar agreement. You were looking for some help with it, is that right?
(If yes) Perfect, that's why I'm calling. This only takes a couple of minutes.
(If unsure) It was a short web form asking for help getting out of, or fixing, a solar lease, loan or power purchase agreement. Ring a bell?

== DISCLOSURE ==
Quick thing before we start: this call may be recorded for quality and training, and I'm with {{company}}, we're not your solar company and we're not the lender. Is it okay to go ahead?
(If no to recording: "No problem." Stop recording per your supervisor's instructions before continuing.)

== QUALIFYING ==
1. Who's the solar company, the one whose name is on the agreement or the panels?
2. And is that set up as a lease, a loan, or a power purchase agreement, the kind where you pay per kilowatt-hour? (If they don't know: "No worries. Do you get a bill from the solar company every month, or did you finance the system through a bank?")
3. Roughly what's the monthly payment on it?
4. How long have you had the system? About when did it go in?
5. And what would you most like to see happen here: get out of the agreement altogether, lower the payment, get a problem with the system fixed, or are you trying to sell the house and the solar is in the way?

== EMPATHY (use where it fits) ==
- "That's a lot of people's story, {{first_name}}. The pitch sounds great and then the bill shows up."
- "I hear you. Paying for something that isn't working the way it was sold is frustrating."
- "You're not the only one in {{city}} dealing with this, and the fact you reached out is the right move."
- "Okay, that helps me a lot. Thank you for being straight with me."

== REBUTTALS ==
"Not interested."
  Totally fair, {{first_name}}. The only reason I'm calling is the form you sent us about your solar agreement. If that's been sorted out, I'll close it out and we're done. If it hasn't, two quick questions tell me whether we can even help. Which is it?

"How did you get my number?"
  You, or someone at this number, filled out a form online asking for help with a solar lease or loan, and that's the only reason I have it. If that wasn't you, say the word and I'll take you off our list right now.

"Just send me something."
  Happy to. So I send the right thing and not a brochure, is it the payment, the contract, or the system itself that's the problem? Also, is this the best number and email for you?

"I'm busy."
  No problem, I'll be quick. Is later today or tomorrow better? I'll put you down for that time so you're not chasing us.
  (Book the callback. Do not push past a second "no".)

"Can you guarantee you'll get me out of it?"
  I can't promise an outcome, and I'd be wary of anyone who does. What I can do is get a specialist to look at your actual agreement and tell you honestly what your options are.

"Stop calling me." / "Take me off your list."
  Understood. I'm adding this number to our do-not-call list right now and you won't hear from {{company}} again. Sorry for the bother. (End the call. Disposition: DNC.)

== TRANSFER BRIDGE ==
{{first_name}}, based on what you've told me, I think it's worth having one of our specialists look at this with you. They handle {{state}} agreements like yours every day. I'm going to bring them in now, it'll take me a few seconds, and I'll introduce you so you don't have to repeat everything. Stay on the line for me, okay?
(To the closer, before joining: "I have {{first_name}} {{last_name}} in {{city}}, {{state}}. [Company], [lease/loan/PPA], about $[payment] a month, had it [time]. Wants to [goal].")
(Back to lead) {{first_name}}, I've got [closer name] here with me. [Closer name], this is {{first_name}}, I've given you the rundown. {{first_name}}, you're in good hands, take care.

== IF NOT QUALIFIED ==
{{first_name}}, I appreciate your time. From what you've described this isn't something we can help with, and I'd rather tell you that than waste your afternoon. I'll close out your request. Take care.

== VOICEMAIL ==
Hi {{first_name}}, this is {{agent}} with {{company}}. I'm returning the request you sent us about your solar agreement. Nothing urgent, I just have a couple of quick questions so we can see whether we're able to help. You can reach me back at this number, or I'll try you again another time. Thanks, {{first_name}}, talk soon.`;

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  { key: "solar-exit-fronter", name: "Solar Exit: fronter (qualify + warm transfer)", body: SOLAR_EXIT_SCRIPT, rebuttals: SOLAR_EXIT_REBUTTALS },
];

/** Rebuttals in the campaign card's line format: "objection | what to say". */
export function rebuttalLines(t: ScriptTemplate): string {
  return t.rebuttals.map((r) => `${r.objection} | ${r.response}`).join("\n");
}

// ── Rendering ─────────────────────────────────────────────────────────────
// The campaign script on the assist screen and the screener script in the
// console banner share one variable set. The dotted forms
// ({{agent.firstName}}, {{lead.firstName}}) are aliases of the snake case
// ones so a script reads naturally either way.

export interface ScriptVars {
  agentName: string;
  company: string;
  lead: { firstName?: string | null; lastName?: string | null; city?: string | null; state?: string | null } | null;
}

/** What an agent says to a phone's call screener so the person picks up. */
export const DEFAULT_SCREENER_SCRIPT = "Hi, this is {{agent.firstName}} with {{company}} returning a call about {{lead.firstName}}'s solar account. Please pick up.";

const ALIASES: Record<string, string> = {
  "agent.firstName": "agent",
  "agent.name": "agent",
  "lead.firstName": "first_name",
  "lead.lastName": "last_name",
  "lead.city": "city",
  "lead.state": "state",
};

/** Fill {{first_name}}, {{last_name}}, {{agent}}, {{company}}, {{city}}, {{state}} and their dotted aliases. Unknown keys are left as written. */
export function renderScript(template: string, vars: ScriptVars): string {
  const values: Record<string, string> = {
    first_name: vars.lead?.firstName || "there",
    last_name: vars.lead?.lastName || "",
    agent: vars.agentName,
    company: vars.company,
    city: vars.lead?.city || "your area",
    state: vars.lead?.state || "",
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, k: string) => {
    const key = ALIASES[k] ?? k;
    return key in values ? values[key]! : whole;
  });
}
