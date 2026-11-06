import assert from "node:assert/strict";
import { test } from "node:test";
import { callerIdFallbackScope, dialsPerLead, foldAreaCodes, isIdlePoolNumber, planDids, type PlanNumber } from "./did-plan";

const num = (id: string, areaCode: string, state: string | null = "FL"): PlanNumber => ({ id, phone: `${areaCode}555${id.padStart(4, "0").slice(-4)}`, areaCode, state });

test("dials per lead: the attempt rule, at most 3", () => {
  assert.equal(dialsPerLead(5), 3);
  assert.equal(dialsPerLead(2), 2);
  assert.equal(dialsPerLead(0), 1);
});

test("small area codes fold into the busiest area code of their state", () => {
  const rows = foldAreaCodes([
    { areaCode: "305", state: "FL", leads: 500 },
    { areaCode: "786", state: "FL", leads: 10 },
    { areaCode: "954", state: "FL", leads: 30 },
    { areaCode: "212", state: "NY", leads: 5 },
    { areaCode: "999", state: null, leads: 3 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.areaCode, r.leads, r.folded]),
    [
      ["305", 510, ["786"]],
      ["954", 30, []],
      ["212", 5, []],
      ["999", 3, []],
    ],
  );
});

test("a week's list: leads / 5 days × 3 dials, 75 a number, 20% spare", () => {
  // 10,000 leads in 305 → 2,000 a day × 3 = 6,000 dials → 80 numbers + 16 spare.
  const p = planDids({ leads: [{ areaCode: "305", state: "FL", leads: 10_000 }], have: [], pool: [], attemptRule: 3, priceCents: 165 });
  const r = p.rows[0]!;
  assert.equal(r.dailyDials, 6000);
  assert.equal(r.needed, 96);
  // New numbers are sized at 65 a day: round(96 × 75 / 65) → 111.
  assert.equal(r.toOrder, 111);
  assert.deepEqual(p.order, [{ areaCode: "305", state: "FL", count: 111 }]);
  assert.equal(p.monthlyOrderCents, 111 * 165);
});

test("at least one spare in the whole plan", () => {
  // 100 leads → 20 a day × 3 = 60 dials → 1 number, round(0.2) = 0 spare → the plan adds one.
  const p = planDids({ leads: [{ areaCode: "305", state: "FL", leads: 100 }], have: [num("1", "305")], pool: [], attemptRule: 3, priceCents: 100 });
  assert.equal(p.rows[0]!.needed, 2);
  assert.equal(p.totals.have, 1);
  assert.equal(p.totals.order, 1); // round(1 × 75 / 65) → 1, never fewer than the shortfall
});

test("pool first: exact area code, then same-state stand-ins unless exactOnly", () => {
  const leads = [{ areaCode: "305", state: "FL", leads: 1000 }]; // 600 dials → 8 + 2 = 10 needed
  const pool = [num("1", "305"), num("2", "305"), num("3", "954"), num("4", "212", "NY")];
  const p = planDids({ leads, have: [num("9", "305")], pool, attemptRule: 3, priceCents: 100 });
  const r = p.rows[0]!;
  assert.equal(r.needed, 10);
  assert.equal(r.have, 1);
  assert.equal(r.takeExact, 2);
  assert.equal(r.takeState, 1);
  assert.equal(r.poolCandidates, 3);
  assert.deepEqual(
    p.take.map((t) => [t.id, t.sameAreaCode]),
    [
      ["1", true],
      ["2", true],
      ["3", false],
    ],
  );
  assert.equal(r.toOrder, 7); // round(6 × 75 / 65)

  const exact = planDids({ leads, have: [num("9", "305")], pool, attemptRule: 3, priceCents: 100, exactOnly: true });
  assert.equal(exact.rows[0]!.takeState, 0);
  assert.equal(exact.rows[0]!.poolCandidates, 2);

  const orderAll = planDids({ leads, have: [], pool, attemptRule: 3, priceCents: 100, poolFirst: false });
  assert.equal(orderAll.take.length, 0);
  assert.equal(orderAll.rows[0]!.toOrder, 12); // round(10 × 75 / 65)
});

test("a pool number serves one row only; enough numbers means nothing to order", () => {
  const p = planDids({
    leads: [
      { areaCode: "305", state: "FL", leads: 100 },
      { areaCode: "954", state: "FL", leads: 100 },
    ],
    have: [num("1", "305"), num("2", "954"), num("3", "407")],
    pool: [num("4", "305")],
    attemptRule: 2,
    priceCents: 100,
  });
  // 100 leads × 2 / 5 = 40 dials each → 1 number each; one plan-wide spare on the first row.
  assert.equal(p.totals.needed, 3);
  assert.equal(p.totals.take, 1);
  assert.equal(p.totals.order, 0);
  assert.equal(p.totals.surplus, 1);
  assert.equal(p.monthlyAllCents, 4 * 100);
});

test("no leads: nothing needed", () => {
  const p = planDids({ leads: [], have: [], pool: [num("1", "305")], attemptRule: 3, priceCents: 100 });
  assert.equal(p.rows.length, 0);
  assert.equal(p.totals.order + p.totals.take, 0);
});

test("idle pool numbers: unused 14+ days, or never used and 14+ days old", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
  assert.equal(isIdlePoolNumber({ campaignId: null, status: "ACTIVE", lastUsedAt: d(15), createdAt: d(60) }, now), true);
  assert.equal(isIdlePoolNumber({ campaignId: null, status: "ACTIVE", lastUsedAt: d(3), createdAt: d(60) }, now), false);
  assert.equal(isIdlePoolNumber({ campaignId: null, status: "ACTIVE", lastUsedAt: null, createdAt: d(20) }, now), true);
  assert.equal(isIdlePoolNumber({ campaignId: null, status: "ACTIVE", lastUsedAt: null, createdAt: d(2) }, now), false);
  assert.equal(isIdlePoolNumber({ campaignId: "c1", status: "ACTIVE", lastUsedAt: null, createdAt: d(90) }, now), false);
  assert.equal(isIdlePoolNumber({ campaignId: null, status: "RETIRED", lastUsedAt: null, createdAt: d(90) }, now), false);
});

test("caller ID fallback scope", () => {
  assert.deepEqual(callerIdFallbackScope("ANY", "FL"), { kind: "any" });
  assert.deepEqual(callerIdFallbackScope("SAME_STATE", "FL"), { kind: "state", state: "FL" });
  assert.deepEqual(callerIdFallbackScope("SAME_STATE", null), { kind: "none" });
  assert.deepEqual(callerIdFallbackScope("EXACT_ONLY", "FL"), { kind: "none" });
});
