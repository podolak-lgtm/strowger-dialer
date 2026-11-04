// Seeds what every install needs: the state calling rules (not per tenant)
// and, in development, a demo tenant with one of each role.
import { STATE_RULES } from "@strowger/shared/compliance";
import { prisma } from "./index.js";

async function seedStateRules() {
  for (const rule of STATE_RULES) {
    await prisma.stateRule.upsert({
      where: { state: rule.state },
      create: {
        state: rule.state,
        startHour: rule.startHour,
        endHour: rule.endHour,
        dayOverrides: rule.dayOverrides ?? {},
        maxAttemptsPerDay: rule.maxAttemptsPerDay ?? null,
        noHolidayCalls: rule.noHolidayCalls ?? false,
        citation: rule.citation ?? null,
      },
      // Never overwrite verifiedAt: counsel's confirmation outlives a reseed.
      update: {
        startHour: rule.startHour,
        endHour: rule.endHour,
        dayOverrides: rule.dayOverrides ?? {},
        maxAttemptsPerDay: rule.maxAttemptsPerDay ?? null,
        noHolidayCalls: rule.noHolidayCalls ?? false,
        citation: rule.citation ?? null,
      },
    });
  }
  console.log(`state rules: ${STATE_RULES.length}`);
}

async function seedDemoTenant() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo" },
    create: { slug: "demo", name: "Demo Contact Center" },
    update: {},
  });
  const people: Array<{ email: string; roles: ("ADMIN" | "SUPERVISOR" | "TEAM_LEADER" | "AGENT")[]; first: string }> = [
    { email: "admin@demo.local", roles: ["ADMIN"], first: "Ada" },
    { email: "super@demo.local", roles: ["SUPERVISOR"], first: "Sam" },
    { email: "lead@demo.local", roles: ["TEAM_LEADER", "AGENT"], first: "Lee" },
    { email: "agent1@demo.local", roles: ["AGENT"], first: "Alex" },
    { email: "agent2@demo.local", roles: ["AGENT"], first: "Bo" },
  ];
  for (const p of people) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: p.email } },
      create: { tenantId: tenant.id, email: p.email, firstName: p.first, lastName: "Demo", roles: p.roles },
      update: { roles: p.roles },
    });
  }
  const campaign = await prisma.campaign.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name: "Demo Campaign" } },
    create: { tenantId: tenant.id, name: "Demo Campaign", dialMode: "PREVIEW" },
    update: {},
  });
  const dispositions = [
    { code: "SALE", label: "Sale", isContact: true, isSale: true, hotkey: "1" },
    { code: "CB", label: "Callback", isContact: true, isCallback: true, hotkey: "2" },
    { code: "NI", label: "Not interested", isContact: true, hotkey: "3" },
    { code: "NA", label: "No answer", recycleAfterMinutes: 180, hotkey: "4" },
    { code: "VM", label: "Voicemail", recycleAfterMinutes: 240, hotkey: "5" },
    { code: "DNC", label: "Do not call", isContact: true, isDnc: true, hotkey: "9" },
  ];
  for (const [i, d] of dispositions.entries()) {
    await prisma.disposition.upsert({
      where: { campaignId_code: { campaignId: campaign.id, code: d.code } },
      create: { tenantId: tenant.id, campaignId: campaign.id, sortOrder: i, ...d },
      update: { label: d.label, sortOrder: i },
    });
  }
  console.log(`demo tenant: ${tenant.slug}, ${people.length} users, campaign "${campaign.name}"`);
}

async function main() {
  await seedStateRules();
  if (process.env.NODE_ENV !== "production") await seedDemoTenant();
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
