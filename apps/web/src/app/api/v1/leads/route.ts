// Affiliate posting: POST /api/v1/leads
//
// Authorization: Bearer <affiliate key>. JSON body or form-encoded. One lead
// per call; the response says accepted, duplicate or rejected, synchronously,
// so the affiliate's system can act on it.
import { prisma } from "@strowger/db";
import { intakeLead, loadList } from "@/lib/intake";
import { affiliateForKey, applyFieldMapping } from "@/lib/affiliates";

export const dynamic = "force-dynamic";

function json(status: number, body: unknown) {
  return Response.json(body, { status });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const b = await req.json();
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
    }
    if (type.includes("form")) {
      const f = await req.formData();
      return Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : v.name]));
    }
    const url = new URL(req.url);
    if ([...url.searchParams.keys()].length) return Object.fromEntries(url.searchParams.entries());
    const text = await req.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : req.headers.get("x-api-key");
  const affiliate = await affiliateForKey(bearer);
  if (!affiliate) return json(401, { status: "error", error: "invalid_api_key" });

  const payload = await readBody(req);
  if (!payload) return json(400, { status: "error", error: "unreadable_body", detail: "Send JSON or form-encoded fields" });

  const mapped = applyFieldMapping(payload, (affiliate.fieldMapping ?? {}) as Record<string, string>);
  const listId = (typeof mapped.list_id === "string" && mapped.list_id) || affiliate.defaultListId;
  if (!listId) return json(400, { status: "error", error: "no_list", detail: "No list_id given and the key has no default list" });

  const list = await loadList(affiliate.tenantId, listId);
  if (!list) return json(400, { status: "error", error: "unknown_list" });
  // An affiliate may only post into lists that are theirs.
  const owned = await prisma.list.findFirst({ where: { id: list.id, affiliateId: affiliate.id }, select: { id: true } });
  if (!owned) return json(403, { status: "error", error: "list_not_yours" });

  const outcome = await intakeLead(
    { tenantId: affiliate.tenantId, listId: list.id, source: "POST", requireConsentFields: true, affiliateId: affiliate.id },
    list,
    mapped,
  );

  switch (outcome.status) {
    case "accepted":
      return json(201, { status: "accepted", lead_id: outcome.leadId });
    case "duplicate":
      return json(200, { status: "duplicate", lead_id: outcome.leadId, action: outcome.action.toLowerCase() });
    case "rejected":
      return json(422, { status: "rejected", reason: outcome.reason, detail: outcome.detail });
  }
}

export async function GET() {
  return json(405, { status: "error", error: "use_post", detail: "POST a lead to this address with Authorization: Bearer <key>" });
}
