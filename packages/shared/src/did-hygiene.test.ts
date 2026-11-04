import assert from "node:assert/strict";
import { test } from "node:test";
import { capForNumber, hourlyCap, numbersNeeded, warmupStage } from "./did-hygiene";

const now = new Date("2026-11-04T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

test("caps follow number age unless overridden", () => {
  assert.equal(capForNumber({ dailyCap: null, firstUsedAt: null }, now), 40);
  assert.equal(capForNumber({ dailyCap: null, firstUsedAt: daysAgo(3) }, now), 40);
  assert.equal(capForNumber({ dailyCap: null, firstUsedAt: daysAgo(10) }, now), 65);
  assert.equal(capForNumber({ dailyCap: null, firstUsedAt: daysAgo(30) }, now), 75);
  assert.equal(capForNumber({ dailyCap: 100, firstUsedAt: daysAgo(1) }, now), 100);
});

test("hourly spread, stages and pool sizing", () => {
  assert.equal(hourlyCap(75), 8);
  assert.equal(warmupStage({ firstUsedAt: daysAgo(15) }, now), "weeks 2–3");
  assert.equal(numbersNeeded(2000), 27);
});
