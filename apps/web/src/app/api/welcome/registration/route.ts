// Onboarding wizard, Texting step: the 10DLC status, polled while the step is
// open (the engine refreshes it from Telnyx and retries a campaign that was
// waiting for its brand).
import { getSession, hasRole, isBarePlatform } from "@/lib/auth";
import { engine } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSession();
  if (!s || !hasRole(s, "ADMIN") || isBarePlatform(s)) return Response.json({ error: "not allowed" }, { status: 403 });
  try {
    return Response.json(await engine(`/onboarding/registration?tenantId=${encodeURIComponent(s.tenant.id)}`));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
