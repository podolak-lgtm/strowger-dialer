import assert from "node:assert/strict";
import { test } from "node:test";
import { bestHand, compareHands, dealCard, periodKeyFor, rightsForLevel, weekKey } from "./games";

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
  assert.ok(rightsForLevel(1, { "1": ["manual_dial"] }).has("manual_dial"));
  assert.ok(!rightsForLevel(1, { "1": ["manual_dial"] }).has("voicemail_drop"));
});
