import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_RIGHTS, DEFAULT_LEVEL_RIGHTS, OPT_IN_RIGHTS, bestHand, compareHands, daysLeft, dealCard, earnsCard, parsePokerRule, periodKeyFor, rightsForLevel, runIsLive, thisWeekWindow, weekKey } from "./games";

test("poker: categories", () => {
  assert.equal(bestHand(["AS", "KS", "QS", "JS", "TS"])!.name, "Straight flush");
  assert.equal(bestHand(["9C", "9D", "9H", "9S", "2C"])!.name, "Four of a kind");
  assert.equal(bestHand(["9C", "9D", "9H", "2S", "2C"])!.name, "Full house");
  assert.equal(bestHand(["2H", "7H", "9H", "JH", "KH"])!.name, "Flush");
  assert.equal(bestHand(["AS", "2C", "3D", "4H", "5S"])!.name, "Straight"); // wheel
  assert.equal(bestHand(["5S", "5C", "5D", "KH", "2S"])!.name, "Three of a kind");
  assert.equal(bestHand(["5S", "5C", "KD", "KH", "2S"])!.name, "Two pair");
  assert.equal(bestHand(["5S", "5C", "KD", "QH", "2S"])!.name, "Pair");
  assert.equal(bestHand(["AS", "5C", "KD", "QH", "2S"])!.name, "High card");
});

test("poker: best five of seven, and fewer than five", () => {
  const h = bestHand(["AS", "AD", "AH", "KC", "KD", "2S", "3S"])!;
  assert.equal(h.name, "Full house");
  assert.equal(bestHand(["AS", "AD"])!.name, "Pair");
  assert.equal(bestHand(["AS"])!.name, "High card");
  assert.equal(bestHand([]), null);
});

test("poker: comparison and kickers", () => {
  const a = bestHand(["KS", "KD", "9H", "5C", "2D"])!;
  const b = bestHand(["KS", "KD", "8H", "5C", "2D"])!;
  assert.ok(compareHands(a, b) > 0);
  const wheel = bestHand(["AS", "2C", "3D", "4H", "5S"])!;
  const six = bestHand(["2S", "3C", "4D", "5H", "6S"])!;
  assert.ok(compareHands(six, wheel) > 0);
  assert.ok(compareHands(bestHand(["2H", "7H", "9H", "JH", "KH"])!, bestHand(["AS", "2C", "3D", "4H", "5S"])!) > 0);
});

test("deal: never a held card; deck runs out", () => {
  const held = ["AS", "KS"];
  for (let i = 0; i < 200; i++) assert.ok(!held.includes(dealCard(held)!));
  const all = [..."CDHS"].flatMap((s) => [..."23456789TJQKA"].map((r) => r + s));
  assert.equal(dealCard(all), null);
});

test("periods and levels", () => {
  assert.equal(weekKey(new Date("2026-11-05T12:00:00Z")), "2026-W45");
  assert.equal(periodKeyFor("MOST_CALLS_TODAY", new Date("2026-11-05T12:00:00Z")), "2026-11-05");
  assert.equal(periodKeyFor("NEXT_SALE"), null);
  assert.ok(rightsForLevel(1).has("voicemail_drop"));
  assert.ok(rightsForLevel(1).has("manual_dial"));
  assert.ok(!rightsForLevel(1).has("transfer"));
  assert.ok(rightsForLevel(5).has("transfer"));
  // Transfer to a typed number is off at every level by default (owner, 5 Nov).
  for (const l of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(!rightsForLevel(l).has("transfer_any_number"), `level ${l}`);
  assert.ok(rightsForLevel(3, { "3": ["transfer_any_number"] }).has("transfer_any_number"));
  assert.ok(rightsForLevel(1, { "1": ["manual_dial"] }).has("manual_dial"));
  assert.ok(!rightsForLevel(1, { "1": ["manual_dial"] }).has("voicemail_drop"));
});

test("poker run rule: what earns a card", () => {
  assert.ok(earnsCard({ qualifies: "SALE", codes: [] }, { isSale: true, isContact: true, code: "SALE" }));
  assert.ok(!earnsCard({ qualifies: "SALE", codes: [] }, { isSale: false, isContact: true, code: "NI" }));
  assert.ok(earnsCard({ qualifies: "CONTACT", codes: [] }, { isSale: false, isContact: true, code: "NI" }));
  assert.ok(!earnsCard({ qualifies: "CONTACT", codes: [] }, { isSale: false, isContact: false, code: "NA" }));
  assert.ok(earnsCard({ qualifies: "CODES", codes: ["XFER", "SALE"] }, { isSale: false, isContact: true, code: "xfer" }));
  assert.ok(!earnsCard({ qualifies: "CODES", codes: ["XFER"] }, { isSale: true, isContact: true, code: "SALE" }));
});

test("poker run rule: parsing the form", () => {
  assert.deepEqual(parsePokerRule("CODES", "sale, xfer xfer;cb"), { qualifies: "CODES", codes: ["SALE", "XFER", "CB"] });
  assert.deepEqual(parsePokerRule("CODES", ""), { qualifies: "SALE", codes: [] }); // no codes: falls back to sales
  assert.deepEqual(parsePokerRule("contact", null), { qualifies: "CONTACT", codes: [] });
  assert.deepEqual(parsePokerRule("nonsense", ["A"]), { qualifies: "SALE", codes: [] });
});

test("poker run window and days left", () => {
  const w = thisWeekWindow(new Date("2026-11-05T12:00:00Z")); // a Thursday
  assert.equal(w.startsAt.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(w.endsAt.toISOString(), "2026-11-09T00:00:00.000Z");
  assert.equal(thisWeekWindow(new Date("2026-11-08T23:00:00Z")).startsAt.toISOString(), "2026-11-02T00:00:00.000Z"); // Sunday still that week
  assert.equal(daysLeft(w.endsAt, new Date("2026-11-05T12:00:00Z")), 4);
  assert.equal(daysLeft(w.endsAt, new Date("2026-11-10T00:00:00Z")), 0);
  const run = { status: "ACTIVE", startsAt: w.startsAt, endsAt: w.endsAt };
  assert.ok(runIsLive(run, new Date("2026-11-05T12:00:00Z")));
  assert.ok(!runIsLive(run, new Date("2026-11-09T00:00:00Z")));
  assert.ok(!runIsLive({ ...run, status: "ENDED" }, new Date("2026-11-05T12:00:00Z")));
});

test("manage_games is a right nobody gets by level alone; a tenant grants it", () => {
  assert.ok("manage_games" in AGENT_RIGHTS);
  assert.ok(OPT_IN_RIGHTS.includes("manage_games"));
  for (const l of Object.keys(DEFAULT_LEVEL_RIGHTS)) assert.ok(!rightsForLevel(Number(l)).has("manage_games"), `level ${l}`);
  assert.ok(rightsForLevel(7, { "7": ["games", "manage_games"] }).has("manage_games"));
});
