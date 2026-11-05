// Report queries shared by the Reports page and the CSV exports.
import { prisma } from "@strowger/db";

export interface ReportRange {
  tenantId: string;
  from: Date;
  to: Date;
  campaignId: string | null;
}

export function parseRange(tenantId: string, q: { from?: string | string[]; to?: string | string[]; campaign?: string | string[] }): ReportRange {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = one(q.from) ? new Date(`${one(q.from)}T00:00:00`) : new Date(today.getTime() - 6 * 86_400_000);
  const to = one(q.to) ? new Date(`${one(q.to)}T23:59:59.999`) : new Date(today.getTime() + 86_400_000 - 1);
  return { tenantId, from, to, campaignId: one(q.campaign) || null };
}

export async function callRows(r: ReportRange) {
  return prisma.call.findMany({
    // Destination legs of external transfers are billed minutes, not dials: they hang off the lead's call.
    where: { tenantId: r.tenantId, direction: { not: "TRANSFER" }, dialedAt: { gte: r.from, lte: r.to }, ...(r.campaignId ? { campaignId: r.campaignId } : {}) },
    orderBy: { dialedAt: "asc" },
    include: {
      campaign: { select: { name: true } },
      agent: { select: { email: true, firstName: true, lastName: true } },
      lead: { select: { firstName: true, lastName: true, state: true, zip: true, listId: true, list: { select: { name: true } } } },
      disposition: { select: { code: true, label: true, isSale: true, isContact: true } },
    },
  });
}

export type CallRow = Awaited<ReturnType<typeof callRows>>[number];

export function agentName(a: { email: string; firstName: string | null; lastName: string | null } | null): string {
  if (!a) return "(dialer)";
  return a.firstName ? `${a.firstName} ${a.lastName ?? ""}`.trim() : a.email;
}

export function summarize(rows: CallRow[]) {
  const connected = rows.filter((c) => c.bridgedAt);
  const sales = rows.filter((c) => c.disposition?.isSale);
  const talk = connected.reduce((n, c) => n + (c.endedAt && c.bridgedAt ? (c.endedAt.getTime() - c.bridgedAt.getTime()) / 1000 : 0), 0);
  return {
    dials: rows.length,
    connected: connected.length,
    contacts: rows.filter((c) => c.disposition?.isContact).length,
    sales: sales.length,
    abandoned: rows.filter((c) => c.abandoned).length,
    voicemail: rows.filter((c) => c.outcome === "VOICEMAIL" || c.outcome === "VOICEMAIL_DROPPED").length,
    noAnswer: rows.filter((c) => c.outcome === "NO_ANSWER" || c.outcome === "BUSY").length,
    talkSeconds: talk,
    connectRate: rows.length ? (connected.length / rows.length) * 100 : 0,
    closeRate: connected.length ? (sales.length / connected.length) * 100 : 0,
    abandonRate: connected.length + rows.filter((c) => c.abandoned).length ? (rows.filter((c) => c.abandoned).length / (connected.length + rows.filter((c) => c.abandoned).length)) * 100 : 0,
  };
}

export function byDisposition(rows: CallRow[]) {
  const m = new Map<string, { code: string; label: string; count: number }>();
  for (const c of rows) {
    const code = c.disposition?.code ?? (c.outcome ?? "NONE");
    const label = c.disposition?.label ?? `(no disposition: ${(c.outcome ?? "none").toLowerCase().replace("_", " ")})`;
    const cur = m.get(code) ?? { code, label, count: 0 };
    cur.count++;
    m.set(code, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

export function byAgent(rows: CallRow[]) {
  const m = new Map<string, { agent: string; dials: number; connected: number; contacts: number; sales: number; talkSeconds: number }>();
  for (const c of rows) {
    const key = c.agentId ?? "dialer";
    const cur = m.get(key) ?? { agent: agentName(c.agent), dials: 0, connected: 0, contacts: 0, sales: 0, talkSeconds: 0 };
    cur.dials++;
    if (c.bridgedAt) {
      cur.connected++;
      if (c.endedAt) cur.talkSeconds += (c.endedAt.getTime() - c.bridgedAt.getTime()) / 1000;
    }
    if (c.disposition?.isContact) cur.contacts++;
    if (c.disposition?.isSale) cur.sales++;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.sales - a.sales || b.connected - a.connected);
}

export function csv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
