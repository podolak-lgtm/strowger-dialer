// Agent levels (owner, 5 Nov): 1–8, each with a set of rights the tenant can
// edit in Settings. Managers (supervisor, room supervisor, admin) have every
// right; team leaders are agents with a team, so they follow their level too.
import { AGENT_RIGHTS, rightsForLevel, type AgentRight } from "@strowger/shared/games";
import type { Session } from "@/lib/auth";

export type { AgentRight };

export function rightsOf(s: Session): Set<AgentRight> {
  if (s.roles.some((r) => r === "ADMIN" || r === "SUPERVISOR" || r === "ROOM_SUPERVISOR")) return new Set(Object.keys(AGENT_RIGHTS) as AgentRight[]);
  const overrides = ((s.tenant.settings ?? {}) as { levelRights?: Record<string, string[]> }).levelRights ?? null;
  return rightsForLevel(s.user.level, overrides);
}

export function requireRight(s: Session, right: AgentRight): void {
  if (!rightsOf(s).has(right)) throw new Error(`Your agent level does not allow this: ${AGENT_RIGHTS[right]}. Ask a supervisor.`);
}

/** Who may start poker runs and switch bets on: admins and supervisors, and a team leader whose level carries `manage_games`. */
export function canManageGames(s: Session): boolean {
  if (s.roles.some((r) => r === "ADMIN" || r === "SUPERVISOR")) return true;
  return s.roles.includes("TEAM_LEADER") && rightsOf(s).has("manage_games");
}

export function requireManageGames(s: Session): void {
  if (!canManageGames(s)) throw new Error("Only a supervisor, admin, or a team leader whose level allows it can run the games.");
}
