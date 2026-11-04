export const ROLES = ["ADMIN", "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER", "AGENT", "AFFILIATE"] as const;
export type RoleName = (typeof ROLES)[number];

/** Who may see the whole tenant's floor. */
export function seesWholeTenant(roles: readonly RoleName[]): boolean {
  return roles.includes("ADMIN") || roles.includes("SUPERVISOR");
}
export function isAdmin(roles: readonly RoleName[]): boolean {
  return roles.includes("ADMIN");
}
export function canSupervise(roles: readonly RoleName[]): boolean {
  return seesWholeTenant(roles) || roles.includes("ROOM_SUPERVISOR") || roles.includes("TEAM_LEADER");
}
