"use client";

// Compliance → Check a number: our DNC list, any lead with that number, and
// Crossbar's scrub (TCPA litigators, do-not-call complainers), in one place.
import { useState } from "react";
import { formatPhone } from "@strowger/shared";
import { checkNumber, type NumberCheck } from "./actions";

export function CheckNumber() {
  const [phone, setPhone] = useState("");
  const [paid, setPaid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NumberCheck | null>(null);

  const run = async () => {
    if (!phone.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const r = await checkNumber(phone.trim(), paid);
    setBusy(false);
    if (r.ok) setResult(r.result);
    else setError(r.error);
  };

  const tone = result?.verdict === "BLOCKED" ? "border-red-500/40 bg-red-500/10 text-red-100" : result?.verdict === "CLEAR" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100" : "border-amber-500/40 bg-amber-500/10 text-amber-100";

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          placeholder="(305) 733-4753"
          inputMode="tel"
          className="w-48 rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm placeholder:text-zinc-600"
        />
        <button onClick={() => void run()} disabled={busy || !phone.trim()} className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-zinc-900 disabled:opacity-40">
          {busy ? "Checking…" : "Check"}
        </button>
        <label className="flex items-center gap-2 text-xs text-zinc-400" title="SubscriberVerify is a paid lookup (a fraction of a cent) for numbers not on the free lists">
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-4 w-4" /> Include the paid SubscriberVerify lookup
        </label>
      </div>
      {error ? <p className="text-red-300">{error}</p> : null}
      {result ? (
        <div className={`space-y-2 rounded-lg border p-3 ${tone}`}>
          <div className="font-semibold">
            {formatPhone(result.phone)}:{" "}
            {result.verdict === "BLOCKED" ? "do not call" : result.verdict === "CLEAR" ? "clear: not on any list we check" : "not fully checked"}
          </div>
          {result.reasons.length ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {result.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          <div className="grid gap-1 text-xs opacity-90 sm:grid-cols-3">
            <div>
              <div className="uppercase tracking-wide opacity-70">Our DNC list</div>
              {result.ourDnc.length ? result.ourDnc.map((d, i) => <div key={i}>{d.scope === "CAMPAIGN" ? `Campaign: ${d.campaign ?? "?"}` : "Workspace"} · {d.source.toLowerCase().replace(/_/g, " ")} · {new Date(d.addedAt).toLocaleDateString()}</div>) : <div>Not listed</div>}
            </div>
            <div>
              <div className="uppercase tracking-wide opacity-70">Crossbar scrub</div>
              {result.crossbar.checked ? (
                result.crossbar.flagged.length ? (
                  result.crossbar.flagged.map((f, i) => <div key={i}>{f.kind === "LITIGATOR" ? "Litigator" : "Complainer"} · {f.source}</div>)
                ) : result.crossbar.unresolved ? (
                  <div>Not on the free lists; SubscriberVerify not checked{result.crossbar.paid ? " (it did not answer)" : " (tick the paid lookup)"}</div>
                ) : (
                  <div>Clean{result.crossbar.paid ? " (DNC, litigator list, SubscriberVerify)" : " (DNC and litigator list)"}</div>
                )
              ) : (
                <div>Could not check: {result.crossbar.error}</div>
              )}
            </div>
            <div>
              <div className="uppercase tracking-wide opacity-70">Leads with this number</div>
              {result.leads.length ? result.leads.map((l) => <div key={l.id}>{l.name} · {l.status.toLowerCase()} · scrub {l.scrubStatus.toLowerCase()}{l.list ? ` · ${l.list}` : ""}</div>) : <div>None</div>}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
