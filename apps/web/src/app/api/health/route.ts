import { prisma } from "@strowger/db";

// Liveness plus a configuration check: which required settings are present
// and look right. Never returns a value, only presence and shape.
export async function GET() {
  const secret = process.env.CLERK_SECRET_KEY ?? "";
  const pub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  const config = {
    clerkSecretKey: secret.length === 0 ? "missing" : /^sk_(test|live)_/.test(secret) ? "ok" : "present but not sk_test_/sk_live_",
    clerkPublishableKey: pub.length === 0 ? "missing" : /^pk_(test|live)_/.test(pub) ? "ok" : "present but not pk_",
    engineInternalKey: (process.env.ENGINE_INTERNAL_KEY ?? "").length >= 32 ? "ok" : "missing or short",
    engineUrl: process.env.ENGINE_PUBLIC_URL ? "ok" : "missing",
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true, config });
  } catch (e) {
    return Response.json({ ok: false, error: String(e), config }, { status: 503 });
  }
}
