"use client";

import { LEAD_FIELDS, LEAD_FIELD_LABELS, type LeadField } from "@strowger/shared";
import Papa from "papaparse";
import { useMemo, useState, useTransition } from "react";
import { Button, inputClass } from "@/components/ui";
import { finishImport, importBatch, startImport, type BatchCounts } from "../import-actions";

type Row = Record<string, string>;

/** Guess our field from a header name. */
function guessField(header: string): LeadField | "" {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  const table: Array<[RegExp, LeadField]> = [
    [/^(first|fname|firstname|givenname)$/, "first_name"],
    [/^(last|lname|lastname|surname|familyname)$/, "last_name"],
    [/^(phone|phonenumber|mobile|cell|cellphone|telephone|tel|primaryphone|phone1)$/, "phone"],
    [/^(address|address1|street|streetaddress|addr)$/, "address"],
    [/^city$/, "city"],
    [/^(state|st|province)$/, "state"],
    [/^(zip|zipcode|postal|postalcode|postcode)$/, "zip"],
    [/^(email|emailaddress|mail)$/, "email"],
    [/^(jornaya|jornayaid|jornayaleadid|leadid|leadidtoken|universalleadid)$/, "jornaya_lead_id"],
    [/^(trustedform|trustedformcert|trustedformurl|trustedformcerturl|xxtrustedformcerturl)$/, "trustedform_cert_url"],
    [/^(optinurl|sourceurl|url|landingpage|landingpageurl)$/, "opt_in_url"],
    [/^(optinat|optindate|optintime|timestamp|createdat|date|datetime|submittedat)$/, "opt_in_at"],
    [/^(ip|ipaddress|optinip)$/, "opt_in_ip"],
    [/^(leadtype|type|vertical|bucket)$/, "lead_type"],
  ];
  for (const [re, f] of table) if (re.test(h)) return f;
  return "";
}

export function UploadWizard({ listId, remembered }: { listId: string; remembered: Record<string, Record<string, string>> }) {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [mapping, setMapping] = useState<Record<string, LeadField | "">>({});
  const [progress, setProgress] = useState<{ done: number; total: number; counts: BatchCounts } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onFile = (f: File | null) => {
    setFile(f);
    setHeaders([]);
    setRows([]);
    setProgress(null);
    setError(null);
    if (!f) return;
    Papa.parse<Row>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const hs = res.meta.fields ?? [];
        setHeaders(hs);
        setRows(res.data);
        const key = hs.slice().sort().join("|");
        const saved = remembered[key];
        const m: Record<string, LeadField | ""> = {};
        for (const h of hs) m[h] = (saved?.[h] as LeadField | undefined) ?? guessField(h);
        setMapping(m);
      },
      error: (e) => setError(e.message),
    });
  };

  const phoneMapped = useMemo(() => Object.values(mapping).includes("phone"), [mapping]);
  const used = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping]);

  const run = () =>
    start(async () => {
      if (!file || !phoneMapped) return;
      setError(null);
      const finalMapping: Record<string, string> = {};
      for (const [h, f] of Object.entries(mapping)) if (f) finalMapping[h] = f;
      const { importId } = await startImport(listId, file.name, finalMapping, rows.length);
      const counts: BatchCounts = { accepted: 0, duplicate: 0, badPhone: 0, dnc: 0, invalid: 0 };
      setProgress({ done: 0, total: rows.length, counts });
      try {
        for (let i = 0; i < rows.length; i += 250) {
          const batch = rows.slice(i, i + 250).map((r) => {
            const out: Record<string, unknown> = {};
            for (const [h, f] of Object.entries(mapping)) out[f || h] = r[h];
            return out;
          });
          const c = await importBatch(importId, batch);
          for (const k of Object.keys(counts) as (keyof BatchCounts)[]) counts[k] += c[k];
          setProgress({ done: Math.min(i + 250, rows.length), total: rows.length, counts: { ...counts } });
        }
        await finishImport(importId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        await finishImport(importId, msg);
      }
    });

  return (
    <div className="space-y-4">
      <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0] ?? null)} className="block text-sm text-zinc-300 file:mr-3 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-100" />
      {error ? <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-200">{error}</div> : null}

      {headers.length > 0 && !progress ? (
        <div className="space-y-3">
          <div className="text-sm text-zinc-400">
            {rows.length.toLocaleString()} rows. Map each column; unmapped columns are kept as custom data.{!phoneMapped ? <span className="text-amber-300"> A phone column is required.</span> : null}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {headers.map((h) => (
              <div key={h} className="flex items-center gap-2 text-sm">
                <div className="w-1/2 truncate font-mono text-xs text-zinc-300" title={h}>
                  {h}
                  <div className="truncate text-[10px] text-zinc-600">{rows[0]?.[h]}</div>
                </div>
                <select value={mapping[h] ?? ""} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value as LeadField | "" })} className={inputClass}>
                  <option value="">(custom)</option>
                  {LEAD_FIELDS.map((f) => (
                    <option key={f} value={f} disabled={used.has(f) && mapping[h] !== f}>
                      {LEAD_FIELD_LABELS[f]}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <Button onClick={run} disabled={!phoneMapped || pending}>
            Import {rows.length.toLocaleString()} rows
          </Button>
        </div>
      ) : null}

      {progress ? (
        <div className="space-y-2 text-sm">
          <div className="h-2 overflow-hidden rounded bg-zinc-800">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
          <div className="text-zinc-400">
            {progress.done.toLocaleString()} / {progress.total.toLocaleString()} processed
            {progress.done === progress.total && !pending ? " · done" : ""}
          </div>
          <div className="grid grid-cols-5 gap-2 text-center">
            {(
              [
                ["Accepted", progress.counts.accepted, "text-emerald-300"],
                ["Duplicates", progress.counts.duplicate, "text-zinc-300"],
                ["Bad phone", progress.counts.badPhone, "text-amber-300"],
                ["DNC", progress.counts.dnc, "text-red-300"],
                ["Invalid", progress.counts.invalid, "text-amber-300"],
              ] as const
            ).map(([label, n, cls]) => (
              <div key={label} className="rounded-md border border-zinc-800 p-2">
                <div className={`text-lg font-semibold tabular-nums ${cls}`}>{n.toLocaleString()}</div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
