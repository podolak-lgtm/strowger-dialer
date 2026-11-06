// "Upload invoice" on /platform → Balances: a PDF or CSV dropped on a vendor's row goes to the engine, which stores
// it in the bucket, has Claude read it and writes its lines (billing/vendors/invoice.ts). Platform admins only.
// The proxy buffers request bodies up to 10 MB (proxyClientMaxBodySize), so files are capped just under that.
import { requireRole } from "@/lib/auth";
import { engine } from "@/lib/engine";

export const dynamic = "force-dynamic";

const MAX_BYTES = 9.5 * 1024 * 1024;

export async function POST(req: Request) {
  const s = await requireRole("ADMIN");
  if (!s.tenant.isPlatform && !s.actingFrom) return Response.json({ ok: false, error: "Platform workspace only" }, { status: 403 });
  const form = await req.formData();
  const vendor = String(form.get("vendor") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ ok: false, error: "No file" }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ ok: false, error: "The file is over 9.5 MB" }, { status: 413 });
  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const r = await engine<{ ok: boolean; period: string; totalCents: number | null; counted: boolean; warning?: string }>("/billing/invoices/upload", {
      method: "POST",
      body: JSON.stringify({ vendor, name: file.name.slice(0, 200), contentType: file.type || null, dataBase64: bytes.toString("base64"), actor: { tenantId: s.actingFrom?.id ?? s.tenant.id, userId: s.user.id } }),
    });
    return Response.json(r);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = /"error":"([^"]+)"/.exec(msg)?.[1] ?? msg.slice(0, 300);
    return Response.json({ ok: false, error: err }, { status: 400 });
  }
}
