// Serves uploaded prompts from the private bucket. Keys are unguessable
// (tenant id + random), which is what makes a public read acceptable: the
// dialer fetches these without a session.
import { isVendorFileKey } from "@strowger/shared/vendor-collect";
import { getObject } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: RouteContext<"/api/media/[...key]">) {
  const { key } = await ctx.params;
  const k = key.map(decodeURIComponent).join("/");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{10,}$/.test(k) || k.includes("..")) return new Response("not found", { status: 404 });
  // Vendor invoices and screenshots have guessable keys and are private: /api/platform/vendor-file serves them to admins.
  if (isVendorFileKey(k)) return new Response("not found", { status: 404 });
  const obj = await getObject(k);
  if (!obj?.body) return new Response("not found", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": obj.contentType ?? "application/octet-stream", "cache-control": "public, max-age=3600", ...(obj.length ? { "content-length": String(obj.length) } : {}) } });
}
