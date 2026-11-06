// Card processor webhooks (TODO(provider): point the processor's webhook at
// WEB_PUBLIC_URL/api/webhooks/payments/<provider>, e.g. /stripe). The raw body
// and headers go to the engine untouched: the provider adapter verifies the
// signature there and credits the ledger through recordPayment. With no
// provider configured the engine answers 404. Public in proxy.ts (webhooks).
import { engine } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: RouteContext<"/api/webhooks/payments/[provider]">) {
  const { provider } = await ctx.params;
  const rawBody = await req.text();
  if (rawBody.length > 1_000_000) return new Response("too large", { status: 413 });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  try {
    const r = await engine("/payments/webhook", { method: "POST", body: JSON.stringify({ provider: provider.slice(0, 20), rawBody, headers }) });
    return Response.json(r);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false }, { status: /: 404 /.test(m) ? 404 : 400 });
  }
}
