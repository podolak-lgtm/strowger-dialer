/**
 * Geographic routing: a number or an IVR option sends a caller to a queue by
 * where they are calling from. An area-code rule beats a state rule (it is
 * the narrower match); within each, the lowest `sortOrder` wins; a fallback
 * rule catches everyone else. The caller's state is the matched lead's state
 * when we know it, else the zone of their number (`resolveZone`).
 */
import { resolveZone } from "../geo/index";

export interface GeoRule {
  id: string;
  states: readonly string[];
  areaCodes: readonly string[];
  targetQueueId: string;
  isFallback: boolean;
  sortOrder: number;
}

export interface CallerGeo {
  state: string | null;
  areaCode: string | null;
}

export function callerGeo(phone: string | null | undefined, lead?: { state?: string | null; zip?: string | null } | null): CallerGeo {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
  const ten = digits.length === 10 ? digits : null;
  const zone = resolveZone({ phone: ten, state: lead?.state ?? null, zip: lead?.zip ?? null });
  return { state: zone?.state ?? (lead?.state?.trim().toUpperCase() || null), areaCode: ten ? ten.slice(0, 3) : null };
}

export function matchGeoRoute<T extends GeoRule>(rules: readonly T[], caller: CallerGeo): T | null {
  const sorted = [...rules].sort((a, b) => a.sortOrder - b.sortOrder);
  const norm = (xs: readonly string[]) => xs.map((x) => x.trim().toUpperCase());
  if (caller.areaCode) {
    const hit = sorted.find((r) => !r.isFallback && r.areaCodes.map((x) => x.trim()).includes(caller.areaCode!));
    if (hit) return hit;
  }
  if (caller.state) {
    const st = caller.state.toUpperCase();
    const hit = sorted.find((r) => !r.isFallback && norm(r.states).includes(st));
    if (hit) return hit;
  }
  return sorted.find((r) => r.isFallback) ?? null;
}

/** "tx, ok ,LA" → ["TX","OK","LA"]; "512 737" → ["512","737"]. The admin form's text boxes. */
export function parseStates(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s)))];
}
export function parseAreaCodes(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /^\d{3}$/.test(s)))];
}
