// A stored vendor invoice or failure screenshot (vendor-invoices/…, vendor-screens/…), for platform admins only.
// The public /api/media route refuses these prefixes.
import { isVendorFileKey } from "@strowger/shared/vendor-collect";
import { requireRole } from "@/lib/auth";
import { getObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) return new Response("Platform workspace only", { status: 403 });
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!isVendorFileKey(key) || key.includes("..") || !/^[\w/.-]+$/.test(key)) return new Response("not found", { status: 404 });
  const obj = await getObject(key);
  if (!obj?.body) return new Response("not found", { status: 404 });
  const name = key.split("/").pop() ?? "file";
  return new Response(obj.body, { headers: { "content-type": obj.contentType ?? "application/octet-stream", "cache-control": "private, no-store", "content-disposition": `inline; filename="${name}"`, ...(obj.length ? { "content-length": String(obj.length) } : {}) } });
}
