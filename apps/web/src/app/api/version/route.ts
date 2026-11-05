import { BUILD_ID } from "@/lib/version";

export const dynamic = "force-dynamic";

// Polled every 60 s by the agent console and the floor page; see lib/version.ts.
export function GET() {
  return Response.json({ version: BUILD_ID }, { headers: { "cache-control": "no-store" } });
}
