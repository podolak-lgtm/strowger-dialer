/**
 * Test phones (owner, 6 Nov: "a switch that's good for 12 hours, I'm testing
 * on my cell phone tonight"). A short list of the workspace's own phones that
 * may be dialled outside the calling window and past the attempt cap, for a
 * limited time. It never applies to any other number, it switches itself off
 * when `until` passes, and DNC still applies (that check is not in the window).
 *
 * Stored on `Tenant.settings.testPhones` as `{ phones: string[], until: ISO }`.
 */

/** How long one "turn on" lasts. */
export const TEST_PHONES_HOURS = 12;
/** A handful of the owner's phones, not a way around the rules for a list. */
export const TEST_PHONES_MAX = 10;

export interface TestPhones {
  phones: string[];
  until: string;
}

const ten = (p: string) => {
  const d = p.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};

/** Parse free text (any separators) into unique ten-digit numbers, capped at TEST_PHONES_MAX. */
export function parseTestPhones(text: string): string[] {
  const out: string[] = [];
  // Phone-shaped runs: "(561) 271-8275", "+1 561 271 8275", "5612718275".
  for (const m of text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) {
    const p = ten(m[0]);
    if (p.length === 10 && !out.includes(p)) out.push(p);
    if (out.length >= TEST_PHONES_MAX) break;
  }
  return out;
}

/** Read the stored value; anything malformed is "off". */
export function readTestPhones(settings: unknown): TestPhones | null {
  const raw = (settings as { testPhones?: unknown } | null | undefined)?.testPhones as Partial<TestPhones> | undefined;
  if (!raw || !Array.isArray(raw.phones) || typeof raw.until !== "string") return null;
  const phones = raw.phones.filter((p): p is string => typeof p === "string").map(ten).filter((p) => p.length === 10);
  if (!phones.length || Number.isNaN(Date.parse(raw.until))) return null;
  return { phones: phones.slice(0, TEST_PHONES_MAX), until: raw.until };
}

/** True while the switch is on and `phone` is on the list. */
export function testPhoneActive(settings: unknown, phone: string, now = new Date()): boolean {
  const t = readTestPhones(settings);
  if (!t || Date.parse(t.until) <= now.getTime()) return false;
  return t.phones.includes(ten(phone));
}

/** The value to store when the switch is turned on now. */
export function turnOnTestPhones(phones: string[], now = new Date()): TestPhones {
  return { phones: phones.map(ten).filter((p) => p.length === 10).slice(0, TEST_PHONES_MAX), until: new Date(now.getTime() + TEST_PHONES_HOURS * 3600_000).toISOString() };
}
