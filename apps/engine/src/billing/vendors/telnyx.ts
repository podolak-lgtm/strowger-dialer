// Telnyx was collected before the connectors existed (billing/vendor.ts); this wraps that code so it sits in the
// same list with the same button and nightly switch. It uses the engine's TELNYX_API_KEY (the same key that places
// calls), so there is nothing to enter.
import { config } from "../../config";
import { pullTelnyxBalance, pullTelnyxCalls, pullTelnyxMessages, pullTelnyxOther, synced } from "../vendor";
import type { Connector } from "./types";

export const telnyx: Connector = {
  vendor: "telnyx",
  label: "Telnyx",
  method: "api",
  collects: "Call, text and per-record detail records for two days (matched to calls and texts) and the balance",
  whereToGet: "Uses the engine's TELNYX_API_KEY (Railway → engine → Variables); nothing to enter here.",
  credentials: [],
  missing: () => (config.TELNYX_API_KEY ? null : "TELNYX_API_KEY is not set on the engine"),
  async collect({ step }) {
    await step("downloading", "Reading Telnyx detail records for the last two days");
    const calls = await pullTelnyxCalls("last_2_days");
    const texts = await pullTelnyxMessages("last_2_days");
    const other = await pullTelnyxOther("last_2_days");
    await synced("telnyx", { usageSyncedAt: new Date() });
    await step("reading", "Reading the balance");
    const balanceCents = await pullTelnyxBalance();
    return { balanceCents, note: `${calls.records} call, ${texts.records} text and ${other.records} other records read` };
  },
};
