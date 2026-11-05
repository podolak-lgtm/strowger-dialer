import assert from "node:assert/strict";
import { test } from "node:test";
import { cardLabel, declinePlan, describeHand, handMakers, isRed, ledgerKind, ordinal, placeLine, rankGlyph, rankStandings, settlementLine, timeLeft, wagerActions } from "./games";
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

// ---- What the agent sees (5 Nov: cards, hand names, place, purse history, bets between agents)

test("cards: accessible labels, colour, corner glyph", () => {
  assert.equal(cardLabel("7H"), "Seven of hearts");
  assert.equal(cardLabel("TS"), "Ten of spades");
  assert.equal(cardLabel("AC"), "Ace of clubs");
  assert.ok(isRed("QD") && isRed("2H") && !isRed("KS") && !isRed("3C"));
  assert.equal(rankGlyph("TD"), "10");
  assert.equal(rankGlyph("JD"), "J");
});

test("hands in words", () => {
  assert.equal(describeHand(bestHand(["KS", "KD", "7H", "7C", "2D"])!), "Two pair, kings and sevens");
  assert.equal(describeHand(bestHand(["AS", "AD", "AH", "KC", "KD"])!), "Full house, aces over kings");
  assert.equal(describeHand(bestHand(["AS", "KS", "QS", "JS", "TS"])!), "Royal flush");
  assert.equal(describeHand(bestHand(["9S", "KS", "QS", "JS", "TS"])!), "Straight flush, king high");
  assert.equal(describeHand(bestHand(["AS", "2C", "3D", "4H", "5S"])!), "Straight, five high");
  assert.equal(describeHand(bestHand(["2H", "7H", "9H", "JH", "KH"])!), "Flush, king high");
  assert.equal(describeHand(bestHand(["6S", "6C", "6D", "6H"])!), "Four sixes");
  assert.equal(describeHand(bestHand(["5S", "5C", "5D", "KH"])!), "Three fives");
  assert.equal(describeHand(bestHand(["QS", "QC", "3D"])!), "Pair of queens");
  assert.equal(describeHand(bestHand(["AS", "5C"])!), "Ace high");
});

test("the cards that make the hand", () => {
  assert.deepEqual(handMakers(bestHand(["KS", "KD", "7H", "7C", "2D"])!).sort(), ["7C", "7H", "KD", "KS"]);
  assert.deepEqual(handMakers(bestHand(["QS", "QC", "3D"])!).sort(), ["QC", "QS"]);
  assert.deepEqual(handMakers(bestHand(["AS", "5C", "9D"])!), ["AS"]);
  assert.equal(handMakers(bestHand(["2H", "7H", "9H", "JH", "KH"])!).length, 5);
  // best five of seven: only the full house, not the spare cards
  const h = bestHand(["AS", "AD", "AH", "KC", "KD", "2S", "3S"])!;
  assert.deepEqual(handMakers(h).sort(), ["AD", "AH", "AS", "KC", "KD"]);
});

test("standings: ranked by compareHands, ties share a place, place line", () => {
  const rows = rankStandings([
    { userId: "a", cards: ["2S", "9D"] },
    { userId: "b", cards: ["KS", "KD"] },
    { userId: "c", cards: ["KH", "KC"] },
    { userId: "d", cards: ["AS"] },
  ]);
  assert.deepEqual(rows.map((r) => r.userId).slice(0, 2).sort(), ["b", "c"]);
  assert.deepEqual(rows.map((r) => r.place), [1, 1, 3, 4]);
  assert.equal(rows[2]!.userId, "d"); // ace high beats nine high
  assert.equal(placeLine(rows, "d"), "You're 3rd of 4");
  assert.equal(placeLine(rows, "b"), "You're tied 1st of 4");
  assert.equal(placeLine(rows, "z"), "No cards yet · 4 on the board");
  assert.equal(placeLine([], "z"), "No cards yet");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
});

test("time left on a run", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  assert.equal(timeLeft("2026-11-07T17:00:00Z", now), "2 days 5 hours left");
  assert.equal(timeLeft("2026-11-06T12:00:00Z", now), "1 day left");
  assert.equal(timeLeft("2026-11-05T15:30:00Z", now), "3 hours left");
  assert.equal(timeLeft("2026-11-05T12:40:00Z", now), "40 min left");
  assert.equal(timeLeft("2026-11-05T12:00:20Z", now), "1 min left");
  assert.equal(timeLeft("2026-11-05T11:00:00Z", now), "ended");
});

test("ledger kinds from the engine's reasons", () => {
  assert.equal(ledgerKind("Monday top-up to 10,000 (2026-W45)"), "topup");
  assert.equal(ledgerKind("Bets on for Solar: topped up to 10,000"), "topup");
  assert.equal(ledgerKind("Bet placed: Who gets the next sale"), "stake");
  assert.equal(ledgerKind("Bet accepted: Most calls today"), "stake");
  assert.equal(ledgerKind("Won: Who gets the next sale"), "won");
  assert.equal(ledgerKind("Lost: Next sale to Maria"), "lost");
  assert.equal(ledgerKind("Push: Most calls today"), "refund");
  assert.equal(ledgerKind("Bet withdrawn"), "refund");
  assert.equal(ledgerKind("Bet expired, nobody took it"), "refund");
  assert.equal(ledgerKind("Declined by Joe: Next sale"), "refund");
  assert.equal(ledgerKind("Something else"), "other");
});

test("bets: who may accept, decline, withdraw", () => {
  const challenge = { status: "OPEN", proposerId: "maria", accepterId: "joe" };
  assert.deepEqual(wagerActions(challenge, "maria"), ["withdraw"]);
  assert.deepEqual(wagerActions(challenge, "joe"), ["accept", "decline"]);
  assert.deepEqual(wagerActions(challenge, "ann"), []);
  const open = { status: "OPEN", proposerId: "maria", accepterId: null };
  assert.deepEqual(wagerActions(open, "ann"), ["accept"]);
  assert.deepEqual(wagerActions({ ...challenge, status: "ACCEPTED" }, "joe"), []);
});

test("bets: declining refunds the proposer in full and only the challenged agent may", () => {
  const w = { status: "OPEN", proposerId: "maria", accepterId: "joe", stake: 500 };
  assert.deepEqual(declinePlan(w, "joe"), { status: "DECLINED", refundTo: "maria", amount: 500 });
  assert.throws(() => declinePlan(w, "maria"));
  assert.throws(() => declinePlan(w, "ann"));
  assert.throws(() => declinePlan({ ...w, accepterId: null }, "ann"));
  assert.throws(() => declinePlan({ ...w, status: "ACCEPTED" }, "joe"));
});

test("bets: settlement toast for each side", () => {
  const e = { winnerId: "maria", proposerId: "maria", accepterId: "joe", proposer: "Maria", accepter: "Joe", short: "Next sale", stake: 500 };
  assert.deepEqual(settlementLine(e, "joe"), { text: "Maria won 500 pts from you on Next sale", tone: "lost" });
  assert.deepEqual(settlementLine(e, "maria"), { text: "You won 500 pts from Joe on Next sale", tone: "won" });
  assert.equal(settlementLine(e, "ann"), null);
  assert.equal(settlementLine({ ...e, winnerId: null, stake: 1500 }, "joe")!.text, "Push on Next sale: your 1,500 pts are back");
});
