import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate, balanceLow, belowFloor, buildPnl, isPeriod, marginOf, nextPeriod, periodsCovered, prevPeriod, sortPnl, spokenChars, toCsv, type ClientInput } from "./accounting";

test("periods step across the year", () => {
  assert.equal(prevPeriod("2026-01"), "2025-12");
  assert.equal(prevPeriod("2026-11"), "2026-10");
  assert.equal(nextPeriod("2026-12"), "2027-01");
  assert.ok(isPeriod("2026-11"));
  assert.ok(!isPeriod("2026-13"));
  assert.ok(!isPeriod("2026-1"));
});

test("a monthly fixed cost covers each month from its start to now, never the future", () => {
  assert.deepEqual(periodsCovered({ cadence: "MONTHLY", startPeriod: "2026-10" }, "2026-12"), ["2026-10", "2026-11", "2026-12"]);
  assert.deepEqual(periodsCovered({ cadence: "MONTHLY", startPeriod: "2026-10", endPeriod: "2026-10" }, "2026-12"), ["2026-10"]);
  assert.deepEqual(periodsCovered({ cadence: "MONTHLY", startPeriod: "2027-01" }, "2026-12"), []);
  assert.deepEqual(periodsCovered({ cadence: "ONCE", startPeriod: "2026-09" }, "2026-12"), ["2026-09"]);
});

test("allocation adds up to the total exactly, by weight", () => {
  const m = allocate(1000, [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
    { id: "c", weight: 1 },
  ]);
  assert.deepEqual([...m.values()].reduce((n, v) => n + v, 0), 1000);
  assert.deepEqual([m.get("a"), m.get("b"), m.get("c")], [334, 333, 333]);
  const w = allocate(10_000, [
    { id: "big", weight: 300 },
    { id: "small", weight: 100 },
    { id: "none", weight: 0 },
  ]);
  assert.equal(w.get("big"), 7500);
  assert.equal(w.get("small"), 2500);
  assert.equal(w.has("none"), false);
});

test("nothing is allocated when no client has any weight", () => {
  assert.equal(allocate(5000, [{ id: "a", weight: 0 }]).size, 0);
  assert.equal(allocate(0, [{ id: "a", weight: 3 }]).size, 0);
});

test("margin % is null without revenue; a loss with no revenue is below the floor", () => {
  assert.deepEqual(marginOf(10_000, 4_000), { marginCents: 6_000, marginPct: 60 });
  assert.deepEqual(marginOf(0, 500), { marginCents: -500, marginPct: null });
  assert.equal(belowFloor(marginOf(10_000, 6_500), 40), true);
  assert.equal(belowFloor(marginOf(10_000, 6_000), 40), false);
  assert.equal(belowFloor(marginOf(0, 500), 40), true);
  assert.equal(belowFloor(marginOf(0, 0), 40), false);
});

const client = (id: string, over: Partial<ClientInput>): ClientInput => ({ id, name: id, seats: 0, minutes: 0, numbers: 0, texts: 0, revenueCents: 0, costByVendorMillicents: {}, ...over });

test("P&L: attributed cost by vendor plus shared costs spread by minutes", () => {
  const p = buildPnl({
    clients: [client("a", { minutes: 300, seats: 1, revenueCents: 20_000, costByVendorMillicents: { telnyx: 2_000_000, anthropic: 1_500 } }), client("b", { minutes: 100, seats: 3, revenueCents: 10_000, costByVendorMillicents: { telnyx: 500_000 } })],
    sharedFixedMillicents: 4_000_000, // $40
    unattributedMillicents: 400_000, // $4
    rule: "MINUTES",
    allocateUnattributed: true,
    floorPct: 40,
  });
  const [a, b] = p.rows as [(typeof p.rows)[0], (typeof p.rows)[0]];
  assert.equal(a.fixedAllocatedCents, 3000);
  assert.equal(b.fixedAllocatedCents, 1000);
  assert.equal(a.unmatchedAllocatedCents, 300);
  assert.equal(a.attributedCents, 2002); // 2,001.5 ¢ rounds once, per client
  assert.equal(a.costCents, 2000 + 3000 + 300 + 2); // 5,301.5 → 5,302 ¢
  assert.equal(b.costCents, 500 + 1000 + 100);
  assert.equal(a.marginPct, 73.5);
  assert.equal(b.belowFloor, false); // 84%
  assert.equal(p.unallocatedMillicents, 0);
  assert.equal(p.totals.revenueCents, 30_000);
  assert.equal(p.totals.costCents, a.costCents + b.costCents);
});

test("P&L: by seats, and unmatched usage left unallocated when switched off", () => {
  const p = buildPnl({
    clients: [client("a", { minutes: 300, seats: 1, revenueCents: 1000 }), client("b", { minutes: 100, seats: 3, revenueCents: 1000 })],
    sharedFixedMillicents: 4_000_000,
    unattributedMillicents: 250_000,
    rule: "SEATS",
    allocateUnattributed: false,
    floorPct: 40,
  });
  assert.equal(p.rows[0]!.fixedAllocatedCents, 1000);
  assert.equal(p.rows[1]!.fixedAllocatedCents, 3000);
  assert.equal(p.rows[1]!.belowFloor, true); // $30 of cost on $10 of revenue
  assert.equal(p.unallocatedMillicents, 250_000);
});

test("P&L: shared costs stay unallocated when no client has used anything", () => {
  const p = buildPnl({ clients: [client("a", {})], sharedFixedMillicents: 1_000_000, unattributedMillicents: 0, rule: "MINUTES", allocateUnattributed: true, floorPct: 40 });
  assert.equal(p.rows[0]!.costCents, 0);
  assert.equal(p.unallocatedMillicents, 1_000_000);
});

test("sorting puts clients with no margin % last", () => {
  const rows = [
    { name: "b", seats: 1, minutes: 1, numbers: 1, texts: 1, revenueCents: 1, costCents: 1, marginCents: 0, marginPct: 10 },
    { name: "a", seats: 1, minutes: 1, numbers: 1, texts: 1, revenueCents: 1, costCents: 1, marginCents: 0, marginPct: null },
    { name: "c", seats: 1, minutes: 1, numbers: 1, texts: 1, revenueCents: 1, costCents: 1, marginCents: 0, marginPct: 50 },
  ];
  assert.deepEqual(sortPnl(rows, "marginPct", "asc").map((r) => r.name), ["b", "c", "a"]);
  assert.deepEqual(sortPnl(rows, "marginPct", "desc").map((r) => r.name), ["c", "b", "a"]);
  assert.deepEqual(sortPnl(rows, "name", "asc").map((r) => r.name), ["a", "b", "c"]);
});

test("balances warn at or under their line, never without one", () => {
  assert.equal(balanceLow(4_000, 5_000), true);
  assert.equal(balanceLow(5_000, 5_000), true);
  assert.equal(balanceLow(6_000, 5_000), false);
  assert.equal(balanceLow(null, 5_000), false);
  assert.equal(balanceLow(100, null), false);
});

test("CSV quotes what needs quoting and defuses formulas", () => {
  assert.equal(toCsv(["a", "b"], [["x, y", 12.5], ['say "hi"', null], ["=SUM(A1)", -3]]), 'a,b\r\n"x, y",12.5\r\n"say ""hi""",\r\n\'=SUM(A1),-3\r\n');
});

test("spoken characters count say verbs and a gather's prompt", () => {
  assert.equal(spokenChars([{ verb: "say", text: "Hello" }, { verb: "play", url: "x" }, { verb: "gather", say: { text: "Press one" } }, { verb: "say", text: ["ab", "cd"] }]), 5 + 9 + 4);
  assert.equal(spokenChars({ verb: "say" }), 0);
});
