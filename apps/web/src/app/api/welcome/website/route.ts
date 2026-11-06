// Onboarding wizard, Business step: the 10DLC website check, as typed. A
// route handler rather than a server action so it never queues behind the
// autosave (server actions run one at a time per browser).
import { readOnboarding } from "@strowger/shared/onboarding";
import { getSession, hasRole, isBarePlatform } from "@/lib/auth";
import { engine } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const s = await getSession();
  if (!s || !hasRole(s, "ADMIN") || isBarePlatform(s)) return Response.json({ error: "not allowed" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { website?: string; names?: string[] };
  const website = String(body.website ?? "").slice(0, 300);
  if (!website.trim()) return Response.json({ error: "no website" }, { status: 400 });
  const b = readOnboarding(s.tenant.onboarding).steps.business ?? {};
  const names = (Array.isArray(body.names) ? body.names : [b.legalName, b.dba]).map((n) => String(n ?? "").slice(0, 120)).filter(Boolean).slice(0, 4);
  try {
    return Response.json(await engine("/onboarding/website", { method: "POST", body: JSON.stringify({ tenantId: s.tenant.id, website, names }) }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
