// Instant rebuttal match for live assist. A final CUSTOMER utterance is
// compared with each objection in the campaign's rebuttal library
// (`Campaign.rebuttals`, [{objection, response}]); the best match above the
// threshold is shown to the agent at once as a "Say this" card, before (and
// instead of) any AI call. Pure and cheap: word overlap on stemmed content
// words, with a bonus for the objection's words appearing in order.

export interface Rebuttal {
  objection: string;
  response: string;
}

export interface RebuttalMatch {
  index: number;
  objection: string;
  response: string;
  /** 0..1 */
  score: number;
}

/** Below this the card is not shown (and the AI may be asked instead). */
export const REBUTTAL_MATCH_THRESHOLD = 0.6;

const STOPWORDS = new Set(
  "a an the and or but so to of in on at for with by from is are was were be been being am i im i'm me my we our you your it its it's this that these those do does did doing have has had just really very about what which who whom how why when where there here they them their he she his her not no yes yeah ok okay well oh uh um like can could would should will shall may might must get got".split(" "),
);

/** Lowercase words, apostrophes kept inside words ("don't"), everything else a separator. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** A very small stemmer: enough that "calls", "calling" and "called" meet. */
export function stem(w: string): string {
  let s = w.replace(/'s$/, "");
  for (const suf of ["ingly", "ings", "ing", "edly", "ed", "ies", "es", "s", "ly"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) {
      s = suf === "ies" ? `${s.slice(0, -3)}y` : s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

/** Negations matter for objections ("not interested"), so they are kept as content. */
const KEEP = new Set(["not", "no", "don't", "dont", "can't", "cant", "won't", "wont", "never", "already"]);

export function contentStems(text: string): string[] {
  return words(text)
    .filter((w) => KEEP.has(w) || (!STOPWORDS.has(w) && w.length > 1))
    .map((w) => (w === "dont" ? "don't" : w === "cant" ? "can't" : w === "wont" ? "won't" : w))
    .map(stem);
}

/** How well `heard` covers `objection`: the share of the objection's content words heard, plus an order bonus. */
export function objectionScore(heard: string, objection: string): number {
  const want = contentStems(objection);
  if (want.length === 0) return 0;
  const got = contentStems(heard);
  const gotSet = new Set(got);
  const hits = want.filter((w) => gotSet.has(w));
  let score = hits.length / want.length;
  // The exact phrase (normalised) in the utterance is a full match.
  const norm = (s: string) => words(s).join(" ");
  if (norm(objection).length > 0 && ` ${norm(heard)} `.includes(` ${norm(objection)} `)) score = 1;
  else if (hits.length >= 2) {
    // Same order as the objection: a small bonus, never past 1.
    const pos = hits.map((h) => got.indexOf(h));
    const ordered = pos.every((p, i) => i === 0 || p > pos[i - 1]!);
    if (ordered) score = Math.min(1, score + 0.1);
  }
  // A one-word objection ("price") only counts when that word is said.
  if (want.length === 1 && hits.length === 1) score = Math.max(score, 0.75);
  return Math.round(score * 1000) / 1000;
}

/** The best rebuttal for what the customer just said, or null when nothing reaches the threshold. */
export function matchRebuttal(heard: string, rebuttals: readonly Rebuttal[], threshold = REBUTTAL_MATCH_THRESHOLD): RebuttalMatch | null {
  let best: RebuttalMatch | null = null;
  rebuttals.forEach((r, index) => {
    if (!r?.objection || !r.response) return;
    const score = objectionScore(heard, r.objection);
    if (score >= threshold && (!best || score > best.score)) best = { index, objection: r.objection, response: r.response, score };
  });
  return best;
}
