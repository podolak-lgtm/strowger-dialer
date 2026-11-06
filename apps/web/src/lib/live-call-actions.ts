"use server";

// Live transcription and assist: what a console or the floor needs to pick up
// a call already in progress (a reload, or a supervisor starting to listen).
// The live stream itself arrives over Socket.IO (engine assist/live.ts).
import { prisma } from "@strowger/db";
import { readTranscript, type TranscriptTurn } from "@strowger/shared/assist";
import type { LiveAlert } from "@strowger/shared/compliance";
import { hasRole, requireSession } from "@/lib/auth";

export type LiveCallState = {
  callId: string;
  transcript: TranscriptTurn[];
  alerts: LiveAlert[];
  summary: string | null;
  suggestion: { dispositionId: string; code: string; label: string; reason: string } | null;
};

/** The agent's own call, or any call in the workspace for a supervisor, room supervisor, team leader or admin. */
export async function liveCallState(callId: string): Promise<LiveCallState | null> {
  const s = await requireSession();
  const manager = hasRole(s, "SUPERVISOR", "ROOM_SUPERVISOR", "TEAM_LEADER");
  const c = await prisma.call.findFirst({
    where: { id: callId, tenantId: s.tenant.id, ...(manager ? {} : { agentId: s.user.id }) },
    select: { id: true, transcript: true, complianceAlerts: true, aiSummary: true, aiHandledAt: true, suggestedDisposition: true },
  });
  if (!c) return null;
  return {
    callId: c.id,
    transcript: readTranscript(c.transcript),
    alerts: Array.isArray(c.complianceAlerts) ? (c.complianceAlerts as unknown as LiveAlert[]) : [],
    // The AI answer's own note (aiHandledAt) is shown by the console's AI panel, not here.
    summary: c.aiHandledAt ? null : c.aiSummary,
    suggestion: (c.suggestedDisposition as LiveCallState["suggestion"]) ?? null,
  };
}
