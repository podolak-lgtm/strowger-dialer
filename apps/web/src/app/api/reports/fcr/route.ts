// The file the Free Caller Registry bulk upload wants: one 10-digit number per
// line, .txt, under 100 KB. Only numbers not yet marked registered, unless ?all=1.
import { prisma } from "@strowger/db";
import { requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const s = await requireRole("SUPERVISOR");
  const all = new URL(req.url).searchParams.get("all") === "1";
  const rows = await prisma.callerIdNumber.findMany({
    where: { tenantId: s.tenant.id, status: { not: "RETIRED" }, ...(all ? {} : { registeredAt: null }) },
    orderBy: { phone: "asc" },
    select: { phone: true },
  });
  const body = rows.map((r) => r.phone).join("\r\n") + (rows.length ? "\r\n" : "");
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="fcr-${s.tenant.slug}-${new Date().toISOString().slice(0, 10)}.txt"` },
  });
}
