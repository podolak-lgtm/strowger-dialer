// Telnyx inbound messages. Verified with the account's Ed25519 public key
// (telnyx-signature-ed25519 over `${timestamp}|${rawBody}`), then handed to
// the engine, which owns attribution, STOP/HELP and agent notification.
import { verify } from "node:crypto";
import { engine } from "@/lib/engine";

export const dynamic = "force-dynamic";

function verified(raw: string, sig: string | null, ts: string | null): boolean {
  const pub = process.env.TELNYX_PUBLIC_KEY;
  if (!pub) return false;
  if (!sig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  try {
    const key = `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub, "base64")]).toString("base64")}\n-----END PUBLIC KEY-----`;
    return verify(null, Buffer.from(`${ts}|${raw}`), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verified(raw, req.headers.get("telnyx-signature-ed25519"), req.headers.get("telnyx-timestamp"))) {
    return new Response("bad signature", { status: 401 });
  }
  let body: { data?: { event_type?: string; payload?: { id?: string; from?: { phone_number?: string }; to?: Array<{ phone_number?: string }>; text?: string; direction?: string } } };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const p = body.data?.payload;
  if (body.data?.event_type !== "message.received" || !p?.from?.phone_number || !p.to?.[0]?.phone_number) return Response.json({ ok: true, ignored: true });
  await engine("/sms/inbound", {
    method: "POST",
    body: JSON.stringify({ provider: "telnyx", providerMessageId: p.id ?? null, from: p.from.phone_number, to: p.to[0].phone_number, body: p.text ?? "" }),
  }).catch(() => undefined);
  return Response.json({ ok: true });
}
