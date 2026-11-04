// Commio (thinQ) inbound SMS. Commio posts the message to a URL you set per
// number or on the messaging profile; authenticate it with a token in the
// URL: https://<host>/api/webhooks/sms/commio?token=<SMS_WEBHOOK_TOKEN>.
// Field names vary by product version, so the common spellings are read.
import { timingSafeEqual } from "node:crypto";
import { engine } from "@/lib/engine";

export const dynamic = "force-dynamic";

function tokenOk(given: string | null): boolean {
  const want = process.env.SMS_WEBHOOK_TOKEN ?? "";
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("json")) return (await req.json()) as Record<string, unknown>;
  const f = await req.formData();
  return Object.fromEntries([...f.entries()].map(([k, v]) => [k, typeof v === "string" ? v : v.name]));
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!tokenOk(url.searchParams.get("token"))) return new Response("unauthorised", { status: 401 });
  let b: Record<string, unknown>;
  try {
    b = await readBody(req);
  } catch {
    return new Response("bad body", { status: 400 });
  }
  const from = str(b.from ?? b.from_did ?? b.From);
  const to = str(b.to ?? b.to_did ?? b.To);
  const text = str(b.message ?? b.body ?? b.text ?? b.Body);
  const id = str(b.id ?? b.message_id ?? b.guid ?? b.MessageSid) || null;
  if (!from || !to) return new Response("missing from/to", { status: 400 });
  await engine("/sms/inbound", { method: "POST", body: JSON.stringify({ provider: "commio", providerMessageId: id, from, to, body: text }) }).catch(() => undefined);
  return Response.json({ ok: true });
}
