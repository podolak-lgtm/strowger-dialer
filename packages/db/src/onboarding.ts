// Atomic edits of `Tenant.onboarding` (the client onboarding wizard). The
// wizard autosaves each step as it is typed while the engine writes the
// registration, the number reservation and the payment request into the same
// JSON, so a read-modify-write could drop one of them. Each edit here is one
// UPDATE on the row: set or merge a value at a path of one or two keys,
// creating the parent object when missing.
import { prisma } from "./client";

export type OnboardingEdit = { set: [string] | [string, string]; value: unknown } | { merge: [string] | [string, string]; value: Record<string, unknown> };

export async function patchOnboarding(tenantId: string, edits: OnboardingEdit[]): Promise<void> {
  if (!edits.length) return;
  await prisma.$transaction(
    edits.map((e) => {
      const path = "set" in e ? e.set : e.merge;
      const json = JSON.stringify(e.value ?? null);
      const [a, b] = path;
      if (b === undefined) {
        return "set" in e
          ? prisma.$executeRaw`UPDATE "Tenant" SET "onboarding" = jsonb_set(coalesce("onboarding", '{}'::jsonb), ARRAY[${a}]::text[], ${json}::jsonb, true) WHERE "id" = ${tenantId}`
          : prisma.$executeRaw`UPDATE "Tenant" SET "onboarding" = jsonb_set(coalesce("onboarding", '{}'::jsonb), ARRAY[${a}]::text[], coalesce("onboarding" -> ${a}, '{}'::jsonb) || ${json}::jsonb, true) WHERE "id" = ${tenantId}`;
      }
      // Two levels: make sure the parent object exists, then set / merge the child.
      return "set" in e
        ? prisma.$executeRaw`UPDATE "Tenant" SET "onboarding" = jsonb_set(jsonb_set(coalesce("onboarding", '{}'::jsonb), ARRAY[${a}]::text[], coalesce("onboarding" -> ${a}, '{}'::jsonb), true), ARRAY[${a}, ${b}]::text[], ${json}::jsonb, true) WHERE "id" = ${tenantId}`
        : prisma.$executeRaw`UPDATE "Tenant" SET "onboarding" = jsonb_set(jsonb_set(coalesce("onboarding", '{}'::jsonb), ARRAY[${a}]::text[], coalesce("onboarding" -> ${a}, '{}'::jsonb), true), ARRAY[${a}, ${b}]::text[], coalesce("onboarding" -> ${a} -> ${b}, '{}'::jsonb) || ${json}::jsonb, true) WHERE "id" = ${tenantId}`;
    }),
  );
}
