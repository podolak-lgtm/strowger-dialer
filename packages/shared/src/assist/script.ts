// Script progress for live assist. The campaign script is broken into steps
// (headings, numbered lines, or blank-line paragraphs) and each step is ticked
// off when the AGENT's transcript has covered enough of its key words. The
// console shows the checklist with the next step highlighted. Pure.
import { contentStems } from "./match";

export interface ScriptStep {
  index: number;
  /** Short label for the checklist: the heading, or the first words. */
  title: string;
  /** The step's text (template variables removed). */
  text: string;
  /** Distinct content stems the agent is expected to say. */
  keywords: string[];
}

/** Share of a step's key words the agent must have said for it to count as covered. */
export const STEP_COVERAGE = 0.5;
/** At most this many key words per step are used (the first ones: openers carry the point). */
export const STEP_KEYWORDS_MAX = 12;
export const SCRIPT_STEPS_MAX = 30;

const HEADING = /^\s*(#{1,6}\s+.+|={2,}\s*.+?\s*={2,}|[A-Z][A-Z0-9 &/'’()—–-]{2,60}:?|\[[^\]]{2,60}\]|.{2,60}:)\s*$/;
const NUMBERED = /^\s*(\d{1,2}[.)]|step\s+\d{1,2}[:.)]?|[-*•])\s+/i;

function stripVars(s: string): string {
  return s.replace(/\{\{[^}]*\}\}/g, " ").replace(/\s+/g, " ").trim();
}

function titleOf(s: string): string {
  const clean = s.replace(/^#+\s*/, "").replace(/^=+\s*|\s*=+$/g, "").replace(/^\[|\]$/g, "").replace(/:$/, "").trim();
  const w = clean.split(/\s+/);
  return w.length > 8 ? `${w.slice(0, 8).join(" ")}…` : clean;
}

function keywordsOf(text: string): string[] {
  const seen: string[] = [];
  for (const s of contentStems(text)) if (s.length >= 3 && !seen.includes(s)) seen.push(s);
  return seen.slice(0, STEP_KEYWORDS_MAX);
}

/**
 * Split a script into steps. A heading line (Markdown `#`, ALL CAPS, `[Name]`
 * or a short line ending in a colon) starts a step titled by it; numbered or
 * bulleted lines are one step each; otherwise blank lines separate steps.
 * Steps with no words to listen for are dropped.
 */
export function scriptSteps(body: string | null | undefined): ScriptStep[] {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const raw: Array<{ title: string | null; lines: string[] }> = [];
  let cur: { title: string | null; lines: string[] } | null = null;
  const push = () => {
    if (cur && (cur.lines.length || cur.title)) raw.push(cur);
    cur = null;
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      // A blank line ends a paragraph step, but not a heading that has no body yet.
      if (cur && cur.lines.length) push();
      continue;
    }
    const bare = stripVars(t).replace(/\(\s*\)/g, "").trim();
    if (bare && HEADING.test(bare) && !NUMBERED.test(t) && bare.split(/\s+/).length <= 8) {
      push();
      cur = { title: titleOf(bare), lines: [] };
      continue;
    }
    if (NUMBERED.test(t)) {
      if (cur && cur.lines.length) push();
      const text = t.replace(NUMBERED, "");
      if (cur && cur.title && cur.lines.length === 0) {
        // The first numbered line under a heading belongs to that heading's step.
        cur.lines.push(text);
        push();
      } else raw.push({ title: null, lines: [text] });
      continue;
    }
    cur ??= { title: null, lines: [] };
    cur.lines.push(t);
  }
  push();
  const steps: ScriptStep[] = [];
  for (const r of raw) {
    const text = stripVars(r.lines.join(" "));
    const keywords = keywordsOf(text || r.title || "");
    if (keywords.length === 0) continue;
    steps.push({ index: steps.length, title: r.title ?? titleOf(text), text, keywords });
    if (steps.length >= SCRIPT_STEPS_MAX) break;
  }
  return steps;
}

/** Key words needed for a step: half of them (rounded up), at least one, all of them for a one- or two-word step. */
export function wordsNeeded(step: Pick<ScriptStep, "keywords">): number {
  const n = step.keywords.length;
  if (n <= 2) return n;
  return Math.max(2, Math.ceil(n * STEP_COVERAGE));
}

export interface ScriptProgress {
  covered: number[];
  /** The first step not yet covered, or null when all are. */
  next: number | null;
}

/** Which steps the agent has covered, given everything they have said on the call so far. */
export function coverSteps(steps: readonly ScriptStep[], agentSaid: readonly string[]): ScriptProgress {
  const said = new Set(contentStems(agentSaid.join(" ")));
  const covered = steps.filter((s) => s.keywords.filter((k) => said.has(k)).length >= wordsNeeded(s)).map((s) => s.index);
  const next = steps.find((s) => !covered.includes(s.index))?.index ?? null;
  return { covered, next };
}
