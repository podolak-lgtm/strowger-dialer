// The Compliance page lists StateRule rows; the dialer enforces STATE_RULES from @strowger/shared. Until 7 Nov
// the rows were written once by the seed and never again, so the page could show hours the dialer no longer
// used. On every engine start the rows are brought in line with the code: a changed rule loses its "verified"
// mark (counsel verified the old wording, not the new one), and a state dropped from the code is deleted.
import { prisma } from "@strowger/db";
import { STATE_RULES } from "@strowger/shared/compliance";
import { log } from "../log";

export async function syncStateRules(): Promise<void> {
  try {
    const rows = await prisma.stateRule.findMany();
    const byState = new Map(rows.map((r) => [r.state, r]));
    let changed = 0;
    for (const rule of STATE_RULES) {
      const data = {
        startHour: rule.startHour,
        endHour: rule.endHour,
        dayOverrides: (rule.dayOverrides ?? {}) as object,
        maxAttemptsPerDay: rule.maxAttemptsPerDay ?? null,
        noHolidayCalls: rule.noHolidayCalls ?? false,
        citation: rule.citation ?? null,
      };
      const cur = byState.get(rule.state);
      const same =
        cur &&
        cur.startHour === data.startHour &&
        cur.endHour === data.endHour &&
        JSON.stringify(cur.dayOverrides ?? {}) === JSON.stringify(data.dayOverrides) &&
        cur.maxAttemptsPerDay === data.maxAttemptsPerDay &&
        cur.noHolidayCalls === data.noHolidayCalls &&
        cur.citation === data.citation;
      if (same) continue;
      changed++;
      await prisma.stateRule.upsert({ where: { state: rule.state }, create: { state: rule.state, ...data }, update: { ...data, verifiedAt: null } });
    }
    const keep = new Set(STATE_RULES.map((r) => r.state));
    const gone = rows.filter((r) => !keep.has(r.state)).map((r) => r.state);
    if (gone.length) await prisma.stateRule.deleteMany({ where: { state: { in: gone } } });
    if (changed || gone.length) log.info({ changed, removed: gone }, "state rules synced from code");
  } catch (e) {
    log.warn({ err: e }, "state rules sync failed; the dialer still enforces the rules in code");
  }
}
