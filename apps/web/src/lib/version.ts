import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Identifies the running build so long-lived pages (agent console, floor)
// can notice a deploy. Server Action ids change with every build, so a page
// opened before a deploy fails with "Server Action … was not found on the
// server" the moment the agent clicks anything; the pages poll
// /api/version and offer a reload instead.
//
// Railway sets RAILWAY_GIT_COMMIT_SHA on the service at build and run time.
// Elsewhere fall back to Next's own build id, then to a per-process id so
// a dev server still behaves (it changes on every restart, which is fine).
function detect(): string {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (sha) return sha;
  try {
    return readFileSync(".next/BUILD_ID", "utf8").trim();
  } catch {
    return `dev-${randomUUID()}`;
  }
}

export const BUILD_ID: string = detect();
