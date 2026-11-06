"use client";

// /platform → Balances, "Vendor connections": per vendor, how its costs are collected, the saved credentials
// (hints only), "Collect now" with a live status line, "Upload invoice" (drop a PDF or CSV on the row) and the
// "Collect nightly" switch. Polls the engine every few seconds while a collection is running.
import { useEffect, useState, useTransition, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { collectVendorNow, saveVendorConnection, setVendorNightly, vendorConnections, type VendorConnectionView, type VendorConnections } from "@/lib/vendor-actions";
import { Badge, Button, inputClass } from "@/components/ui";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");
const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const METHOD: Record<VendorConnectionView["method"], string> = { api: "API", browser: "Browser sign-in", "api+browser": "API + browser" };
const fileHref = (key: string) => `/api/platform/vendor-file?key=${encodeURIComponent(key)}`;

export function VendorConnectionsCard({ initial }: { initial: VendorConnections }) {
  const [data, setData] = useState(initial);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const router = useRouter();
  const running = data.connectors.some((c) => c.progress?.state === "running");

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void vendorConnections().then((next) => {
        if (!next) return;
        setData(next);
        if (!next.connectors.some((c) => c.progress?.state === "running")) router.refresh();
      });
    }, 3000);
    return () => clearInterval(t);
  }, [running, router]);

  const reload = async () => {
    const next = await vendorConnections();
    if (next) setData(next);
    router.refresh();
  };

  return (
    <div>
      {!data.secretsConfigured ? <div className="mb-3 rounded-md border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">VENDOR_SECRETS_KEY is not set on the engine, so logins and keys cannot be saved. Set it on Railway (engine → Variables) to a random value of 32+ characters, e.g. the output of <code>openssl rand -base64 32</code>.</div> : null}
      {!data.invoiceReadingConfigured ? <div className="mb-3 rounded-md border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">ANTHROPIC_API_KEY is not set on the engine, so downloaded and uploaded invoices cannot be read.</div> : null}
      {!data.bucketConfigured ? <div className="mb-3 rounded-md border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">The media bucket is not configured on the engine (S3_*), so invoice files and failure screenshots are not kept.</div> : null}
      {notice ? <div className={`mb-3 rounded-md border p-2 text-sm ${notice.kind === "ok" ? "border-emerald-700 bg-emerald-950/40 text-emerald-200" : "border-red-800 bg-red-950/40 text-red-200"}`}>{notice.text}</div> : null}
      <div className="divide-y divide-zinc-800">
        {data.connectors.map((c) => (
          <VendorRow key={c.vendor} c={c} secretsConfigured={data.secretsConfigured} onChanged={reload} onNotice={setNotice} />
        ))}
      </div>
      <Invoices data={data} />
    </div>
  );
}

function VendorRow({ c, secretsConfigured, onChanged, onNotice }: { c: VendorConnectionView; secretsConfigured: boolean; onChanged: () => Promise<void>; onNotice: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  const [pending, start] = useTransition();
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const p = c.progress;
  const live = p?.state === "running";

  const collect = () =>
    start(async () => {
      onNotice(null);
      const r = await collectVendorNow(c.vendor);
      if (!r.ok) onNotice({ kind: "error", text: `${c.label}: ${r.error}` });
      await onChanged();
    });
  const toggleNightly = (on: boolean) =>
    start(async () => {
      const r = await setVendorNightly(c.vendor, on);
      if (!r.ok) onNotice({ kind: "error", text: `${c.label}: ${r.error}` });
      await onChanged();
    });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    onNotice(null);
    try {
      const form = new FormData();
      form.set("vendor", c.vendor);
      form.set("file", file);
      const res = await fetch("/api/platform/vendor-invoice", { method: "POST", body: form });
      const r = (await res.json().catch(() => ({ ok: false, error: `Upload failed (${res.status})` }))) as { ok: boolean; error?: string; period?: string; totalCents?: number | null; counted?: boolean; warning?: string };
      onNotice(r.ok ? { kind: "ok", text: `${c.label} ${r.period}: read ${r.totalCents == null ? "" : usd(r.totalCents)}${r.counted ? ", counted as the month's cost" : ", kept for reconciliation (this vendor is counted per use)"}${r.warning ? `. ${r.warning}` : ""}.` } : { kind: "error", text: `${c.label}: ${r.error}` });
      await onChanged();
    } finally {
      setUploading(false);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDrag(false);
    void upload(e.dataTransfer.files[0]);
  };

  const status = live ? (
    <span className="flex items-center gap-2 text-sky-300">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" />
      {p.step}… {p.log.at(-1)?.line}
    </span>
  ) : c.lastStatus === "ok" ? (
    <span className="text-emerald-300">Done {when(c.lastRunAt)}{c.lastError ? <span className="text-amber-300"> (warnings: {c.lastError})</span> : null}</span>
  ) : c.lastStatus === "failed" ? (
    <span className="text-red-300">Failed {when(c.lastRunAt)}: {c.lastError}</span>
  ) : c.lastStatus === "needs_person" ? (
    <span className="text-amber-300">Needs a person ({when(c.lastRunAt)}): {c.lastError}</span>
  ) : (
    <span className="text-zinc-500">Not collected yet</span>
  );

  return (
    <div
      className={`py-3 ${drag ? "rounded-md bg-sky-950/40 outline outline-1 outline-sky-600" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{c.label}</span>
            <Badge tone={c.method === "api" ? "green" : "blue"}>{METHOD[c.method]}</Badge>
            {c.invoiceMode === "reconcile" ? <Badge tone="zinc">invoice = reconciliation</Badge> : null}
            {c.balanceCents !== null ? <span className={`text-xs tabular-nums ${c.lowBalanceCents !== null && c.balanceCents <= c.lowBalanceCents ? "font-semibold text-red-300" : "text-zinc-400"}`}>balance {usd(c.balanceCents)}</span> : null}
          </div>
          <div className="mt-0.5 text-xs text-zinc-400">{c.collects}</div>
          <div className="mt-1 text-xs">{status}</div>
          <div className="mt-0.5 text-xs text-zinc-500">
            Last success {when(c.lastSuccessAt)}
            {c.lastScreenshotKey && !live ? (
              <>
                {" · "}
                <a href={fileHref(c.lastScreenshotKey)} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                  screenshot of the failed page
                </a>
              </>
            ) : null}
            {c.missing ? <span className="text-amber-300"> · {c.missing}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={collect} disabled={pending || live || Boolean(c.missing)} className="px-3 py-1.5 text-xs" title={c.missing ?? undefined}>
            {live ? "Collecting…" : "Collect now"}
          </Button>
          <label className={`cursor-pointer rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 ${uploading ? "opacity-60" : ""}`} title="Or drop a PDF or CSV on this row">
            {uploading ? "Reading…" : "Upload invoice"}
            <input type="file" accept="application/pdf,.pdf,text/csv,.csv" className="hidden" disabled={uploading} onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-300">
            <input type="checkbox" checked={c.nightly} disabled={pending} onChange={(e) => toggleNightly(e.target.checked)} />
            Collect nightly
          </label>
        </div>
      </div>
      {c.fields.length ? <Credentials c={c} secretsConfigured={secretsConfigured} onChanged={onChanged} onNotice={onNotice} /> : <div className="mt-1 text-xs text-zinc-500">{c.whereToGet}</div>}
    </div>
  );
}

function Credentials({ c, secretsConfigured, onChanged, onNotice }: { c: VendorConnectionView; secretsConfigured: boolean; onChanged: () => Promise<void>; onNotice: (n: { kind: "ok" | "error"; text: string } | null) => void }) {
  const [pending, start] = useTransition();
  const saved = c.fields.some((f) => f.hint && !f.hint.startsWith("from "));
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-sky-400">{saved ? "Credentials saved: change" : "Enter credentials"}</summary>
      <p className="mt-2 text-zinc-400">{c.whereToGet}</p>
      <form
        className="mt-2 grid gap-2 md:grid-cols-2"
        action={(fd) =>
          start(async () => {
            const r = await saveVendorConnection(fd);
            onNotice(r.ok ? { kind: "ok", text: `${c.label}: saved.` } : { kind: "error", text: `${c.label}: ${r.error}` });
            await onChanged();
          })
        }
      >
        <input type="hidden" name="vendor" value={c.vendor} />
        {c.fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-zinc-400">{f.label}</span>
            <input name={`f:${f.key}`} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.hint ?? (f.optional ? "optional" : "")} className={`${inputClass} mt-0.5 py-1 text-xs`} />
            {f.hint && !f.hint.startsWith("from ") ? (
              <span className="mt-0.5 flex items-center gap-1 text-zinc-500">
                <input type="checkbox" name={`clear:${f.key}`} /> remove the saved value
              </span>
            ) : null}
          </label>
        ))}
        <div className="md:col-span-2">
          <Button type="submit" disabled={pending || !secretsConfigured} className="px-3 py-1 text-xs">
            Save (sealed; blank fields keep what is saved)
          </Button>
        </div>
      </form>
    </details>
  );
}

function Invoices({ data }: { data: VendorConnections }) {
  if (!data.invoices.length) return <p className="mt-4 text-xs text-zinc-500">No invoices read yet. Downloaded invoices and uploads appear here.</p>;
  const label = (v: string) => data.connectors.find((c) => c.vendor === v)?.label ?? v;
  return (
    <div className="mt-5">
      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Invoices read</div>
      <table className="w-full text-xs">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="py-1 font-normal">Vendor</th>
            <th className="py-1 font-normal">Month</th>
            <th className="py-1 font-normal">Invoice</th>
            <th className="py-1 font-normal">Total</th>
            <th className="py-1 font-normal">Counted</th>
            <th className="py-1 font-normal">From</th>
            <th className="py-1 font-normal">File</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {data.invoices.map((i) => (
            <tr key={i.id}>
              <td className="py-1">{label(i.vendor)}</td>
              <td className="py-1 tabular-nums">{i.period}</td>
              <td className="py-1">{i.invoiceNumber ?? "—"}</td>
              <td className="py-1 tabular-nums">{i.totalCents == null ? "—" : `${usd(i.totalCents)}${i.currency && i.currency !== "USD" ? ` ${i.currency}` : ""}`}</td>
              <td className="py-1">{i.status === "read" ? "as the month's cost" : i.status === "reconcile" ? "beside ours only" : i.status}{i.error ? <div className="text-amber-300">{i.error}</div> : null}</td>
              <td className="py-1 text-zinc-400">{i.origin}</td>
              <td className="py-1">
                {i.fileKey ? (
                  <a href={fileHref(i.fileKey)} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                    open
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
