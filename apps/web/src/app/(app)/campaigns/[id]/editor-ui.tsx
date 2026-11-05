"use client";

// Inputs bound to the campaign editor's draft. Every control reads its value
// from the draft and writes back through `edit`; nothing here talks to the
// server. Error ids ("settings.name", "dispositions.<key>.code") match what
// saveCampaignAll returns, and each input carries data-field so the editor can
// scroll to and focus the first one with an error.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { CampaignDraft } from "@strowger/shared/campaign-draft";
import type { CampaignSettingKey } from "@strowger/shared/campaign-form";

export interface EditorApi {
  draft: CampaignDraft;
  edit: (fn: (d: CampaignDraft) => CampaignDraft) => void;
  errors: Record<string, string>;
  clearError: (field: string) => void;
  newKey: () => string;
}

export const EditorContext = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const v = useContext(EditorContext);
  if (!v) throw new Error("useEditor outside CampaignEditor");
  return v;
}

export const inputCls = "min-w-0 rounded-md border bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:outline-none";
export const okBorder = "border-zinc-700 focus:border-zinc-500";
export const errBorder = "border-red-500 ring-1 ring-red-500/60 focus:border-red-400";
/** Input classes; full width unless `extra` sets a width (w-…). */
export const cls = (error: string | undefined, extra = "") => `${inputCls} ${/(^|\s)w-/.test(extra) ? "" : "w-full"} ${error ? errBorder : okBorder} ${extra}`;

export function Card({ title, actions, children, className = "" }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 p-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A short hint with the long explanation behind a "How this works" toggle (in the flow, so it never widens the page). */
export function Hint({ children, more }: { children?: ReactNode; more?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs text-zinc-500">
      {children}
      {more ? (
        <>
          {children ? " " : null}
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-sky-400 underline-offset-2 hover:underline" aria-expanded={open}>
            {open ? "Hide" : "How this works"}
          </button>
          {open ? <div className="mt-1.5 rounded-md border border-zinc-800 bg-zinc-950/70 p-2.5 leading-relaxed text-zinc-400">{more}</div> : null}
        </>
      ) : null}
    </div>
  );
}

export function FieldBox({ label, error, hint, children, className = "" }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 text-sm ${className}`}>
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="mt-0.5">{children}</div>
      {error ? <span className="mt-0.5 block text-xs text-red-400">{error}</span> : hint ? <div className="mt-0.5 text-xs text-zinc-500">{hint}</div> : null}
    </label>
  );
}

function useSetting(k: CampaignSettingKey) {
  const { draft, edit, errors, clearError } = useEditor();
  const field = `settings.${k}`;
  return {
    value: draft.settings[k],
    error: errors[field],
    field,
    set: (v: string | boolean) => {
      clearError(field);
      edit((d) => ({ ...d, settings: { ...d.settings, [k]: v } }));
    },
  };
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "name">;

export function SettingInput({ k, label, hint, className, ...rest }: { k: CampaignSettingKey; label: string; hint?: ReactNode } & InputProps) {
  const s = useSetting(k);
  return (
    <FieldBox label={label} error={s.error} hint={hint} className={className}>
      <input {...rest} name={k} data-field={s.field} aria-invalid={Boolean(s.error)} value={String(s.value)} onChange={(e) => s.set(e.target.value)} className={cls(s.error)} />
    </FieldBox>
  );
}

export function SettingSelect({ k, label, hint, children, className }: { k: CampaignSettingKey; label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  const s = useSetting(k);
  return (
    <FieldBox label={label} error={s.error} hint={hint} className={className}>
      <select name={k} data-field={s.field} value={String(s.value)} onChange={(e) => s.set(e.target.value)} className={cls(s.error)}>
        {children}
      </select>
    </FieldBox>
  );
}

export function SettingTextarea({ k, label, hint, rows, placeholder }: { k: CampaignSettingKey; label: string; hint?: ReactNode; rows: number; placeholder?: string }) {
  const s = useSetting(k);
  return (
    <FieldBox label={label} error={s.error} hint={hint}>
      <textarea name={k} data-field={s.field} rows={rows} placeholder={placeholder} value={String(s.value)} onChange={(e) => s.set(e.target.value)} className={cls(s.error, "font-mono text-xs")} />
    </FieldBox>
  );
}

export function SettingCheck({ k, label }: { k: CampaignSettingKey; label: ReactNode }) {
  const s = useSetting(k);
  return (
    <label className="flex items-start gap-2 text-sm text-zinc-300">
      <input type="checkbox" name={k} data-field={s.field} checked={s.value === true} onChange={(e) => s.set(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-700 bg-zinc-950" />
      <span>{label}</span>
    </label>
  );
}

// ---- Rows (dial plans, dispositions, transfers, webhooks)

export type RowCollection = "dialPlans" | "dispositions" | "transfers" | "webhooks";
type RowOf<C extends RowCollection> = CampaignDraft[C][number];

export function useRows<C extends RowCollection>(coll: C) {
  const { draft, edit, errors, clearError, newKey } = useEditor();
  const rows = draft[coll] as RowOf<C>[];
  const put = (next: RowOf<C>[]) => edit((d) => ({ ...d, [coll]: next }));
  return {
    rows,
    errorOf: (key: string, f: string) => errors[`${coll}.${key}.${f}`],
    rowHasError: (key: string) => Object.keys(errors).some((e) => e.startsWith(`${coll}.${key}.`)),
    patch: (key: string, p: Partial<RowOf<C>>) => {
      for (const f of Object.keys(p)) clearError(`${coll}.${key}.${f}`);
      put(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
    },
    remove: (key: string) => put(rows.filter((r) => r.key !== key)),
    add: (row: Omit<RowOf<C>, "key" | "id">, where: "start" | "end" = "end") => {
      const r = { ...row, key: newKey(), id: null } as RowOf<C>;
      put(where === "start" ? [r, ...rows] : [...rows, r]);
      return r.key;
    },
    replace: put,
  };
}

/** A text/number input bound to one field of one row. */
export function RowInput<C extends RowCollection>({ coll, row, f, label, className = "", ...rest }: { coll: C; row: RowOf<C>; f: keyof RowOf<C> & string; label: string } & InputProps) {
  const r = useRows(coll);
  const error = r.errorOf(row.key, f);
  return (
    <input
      {...rest}
      aria-label={label}
      title={error ?? rest.title ?? label}
      data-field={`${coll}.${row.key}.${f}`}
      aria-invalid={Boolean(error)}
      value={String((row as unknown as Record<string, unknown>)[f] ?? "")}
      onChange={(e) => r.patch(row.key, { [f]: e.target.value } as Partial<RowOf<C>>)}
      className={cls(error, `${rest.type === "number" ? "px-1.5" : "px-2"} py-1 ${className}`)}
    />
  );
}

export function RowCheck<C extends RowCollection>({ coll, row, f, label }: { coll: C; row: RowOf<C>; f: keyof RowOf<C> & string; label: string }) {
  const r = useRows(coll);
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={label}
      data-field={`${coll}.${row.key}.${f}`}
      checked={(row as unknown as Record<string, unknown>)[f] === true}
      onChange={(e) => r.patch(row.key, { [f]: e.target.checked } as Partial<RowOf<C>>)}
      className="h-4 w-4 rounded border-zinc-700 bg-zinc-950"
    />
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800">
      {children}
    </button>
  );
}

export function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded px-1.5 py-0.5 text-sm text-zinc-500 hover:bg-red-950 hover:text-red-300">
      ✕
    </button>
  );
}

/** Small label shown above an input only while a table row is stacked as a card; `hide` is the container-query class that hides it once the row is a table row (e.g. "@min-[680px]:hidden"). */
export function StackLabel({ children, hide }: { children: ReactNode; hide: string }) {
  return <span className={`mb-0.5 block text-[10px] uppercase tracking-wide text-zinc-500 ${hide}`}>{children}</span>;
}
