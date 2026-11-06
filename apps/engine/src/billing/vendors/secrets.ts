// Vendor credentials at rest: one JSON object per vendor, sealed with AES-256-GCM
// under VENDOR_SECRETS_KEY (engine only; the web app never holds the key and
// never receives a saved value back, only "saved, ending …1234").
import { decryptString, encryptString } from "@strowger/shared/secrets";
import { config } from "../../config";

export const secretsConfigured = Boolean(config.VENDOR_SECRETS_KEY);

export function seal(values: Record<string, string>): string {
  if (!config.VENDOR_SECRETS_KEY) throw new Error("VENDOR_SECRETS_KEY is not set on the engine, so credentials cannot be saved");
  return encryptString(JSON.stringify(values), config.VENDOR_SECRETS_KEY);
}

/** The saved values, or {} when nothing is saved. Throws when they cannot be opened (the key changed). */
export function unseal(blob: string | null | undefined): Record<string, string> {
  if (!blob) return {};
  if (!config.VENDOR_SECRETS_KEY) throw new Error("VENDOR_SECRETS_KEY is not set on the engine, so the saved credentials cannot be read");
  const plain = decryptString(blob, config.VENDOR_SECRETS_KEY);
  if (plain === null) throw new Error("The saved credentials cannot be opened with the current VENDOR_SECRETS_KEY; enter them again");
  return JSON.parse(plain) as Record<string, string>;
}
