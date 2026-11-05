"use client";

// Transfers: a compact table of the campaign's destinations; a row opens the
// full form in a side panel. "Done" writes the panel into the draft (Save
// writes it to the server). Deactivate/Activate is the one immediate action.
import { useState } from "react";
import type { TransferDraft } from "@strowger/shared/campaign-draft";
import { formatDestination } from "@strowger/shared/campaign-form";
import { formatPhone } from "@strowger/shared/phone";
import { DEFAULT_WHISPER, TRANSFER_CAP_MINUTES, TRANSFER_RING_SECONDS, WHISPER_VARIABLES } from "@strowger/shared/transfers";
import { Badge } from "@/components/ui";
import { AddButton, Card, FieldBox, Hint, cls, useEditor, useRows } from "./editor-ui";

export type TransferPanel = { key: string } | { key: null } | null;
export interface CopySource {
  id: string;
  name: string;
  destinations: Omit<TransferDraft, "key" | "id">[];
}

const blank: Omit<TransferDraft, "key" | "id"> = { name: "", phone: "", type: "COLD", callerIdMode: "CUSTOMER", staticCallerId: "", whisperOn: true, whisperText: "", active: true };

export function TransfersTab({ ownNumbers, copySources, panel, setPanel, onToggleActive, busy }: { ownNumbers: string[]; copySources: CopySource[]; panel: TransferPanel; setPanel: (p: TransferPanel) => void; onToggleActive: (row: TransferDraft) => void; busy: boolean }) {
  const t = useRows("transfers");
  const { newKey } = useEditor();
  const [from, setFrom] = useState(copySources[0]?.id ?? "");
  const [copied, setCopied] = useState<string | null>(null);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= t.rows.length) return;
    const next = [...t.rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    t.replace(next);
  };
  const copy = () => {
    const src = copySources.find((c) => c.id === from);
    if (!src) return;
    const have = new Set(t.rows.map((r) => r.name.trim().toLowerCase()));
    const add = src.destinations.filter((d) => !have.has(d.name.trim().toLowerCase()));
    let rows = t.rows;
    for (const d of add) rows = [...rows, { ...d, key: newKey(), id: null }];
    t.replace(rows);
    setCopied(`${add.length} copied from ${src.name}${add.length < src.destinations.length ? `, ${src.destinations.length - add.length} skipped (same name)` : ""}`);
  };
  const open = panel ? (panel.key ? (t.rows.find((r) => r.key === panel.key) ?? null) : null) : null;

  return (
    <>
      <Card
        title={`Transfer destinations (${t.rows.length})`}
        className="min-[900px]:col-span-2"
        actions={
          <>
            {copySources.length ? (
              <>
                <select aria-label="Copy destinations from campaign" value={from} onChange={(e) => setFrom(e.target.value)} className={cls(undefined, "w-40 py-1 text-xs")}>
                  {copySources.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <AddButton onClick={copy}>Copy from campaign</AddButton>
              </>
            ) : null}
            <AddButton onClick={() => setPanel({ key: null })}>+ Add destination</AddButton>
          </>
        }
      >
        <Hint
          more={
            <>
              The lead is never put on hold: the destination is dialled straight into the call, hears the whisper alone, then joins. <strong>Cold</strong> drops the agent the moment the destination answers; <strong>warm</strong> keeps the agent on until they click Leave. No answer in {TRANSFER_RING_SECONDS} s and the agent keeps the lead. After the agent leaves, the two sides get {TRANSFER_CAP_MINUTES} minutes. Caller ID <em>customer</em> shows the lead&apos;s own number to the destination; <em>fixed</em> shows one of our numbers. Whisper variables: {WHISPER_VARIABLES.map((v) => `{{${v}}}`).join(" ")}. Removing a destination that has been used deactivates it instead, so its history stays. Copy from campaign adds that campaign&apos;s active destinations (names already here are skipped).
            </>
          }
        >
          Where agents can hand a live lead. Click a row to edit it.
        </Hint>
        {copied ? <p className="mt-1 text-xs text-sky-300">{copied}. Save to keep them.</p> : null}
        <div className="mt-2 @container">
          <div className="hidden grid-cols-[52px_minmax(0,1.2fr)_130px_64px_120px_minmax(0,1.4fr)_64px] gap-2 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 @min-[720px]:grid">
            <span>Order</span>
            <span>Name</span>
            <span>Number</span>
            <span>Default</span>
            <span>Caller ID</span>
            <span>Whisper</span>
            <span>Status</span>
          </div>
          <div className="space-y-1.5 @min-[720px]:space-y-0 @min-[720px]:divide-y @min-[720px]:divide-zinc-800">
            {t.rows.map((r, i) => {
              const bad = t.rowHasError(r.key);
              return (
                <div
                  key={r.key}
                  role="button"
                  tabIndex={0}
                  data-field={`transfers.${r.key}.row`}
                  onClick={() => setPanel({ key: r.key })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setPanel({ key: r.key });
                  }}
                  className={`grid cursor-pointer grid-cols-[52px_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 rounded-md border p-2 text-sm hover:bg-zinc-800/60 @min-[720px]:grid-cols-[52px_minmax(0,1.2fr)_130px_64px_120px_minmax(0,1.4fr)_64px] @min-[720px]:rounded-none @min-[720px]:border-0 @min-[720px]:py-1.5 ${bad ? "border-red-500 @min-[720px]:bg-red-950/30" : "border-zinc-800"} ${panel?.key === r.key ? "bg-zinc-800/80" : ""} ${r.active ? "" : "opacity-60"}`}
                >
                  <span className="row-span-6 flex gap-0.5 self-start @min-[720px]:row-span-1 @min-[720px]:self-center" onClick={(e) => e.stopPropagation()}>
                    <button type="button" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="rounded px-1 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30">
                      ↑
                    </button>
                    <button type="button" aria-label={`Move ${r.name} down`} disabled={i === t.rows.length - 1} onClick={() => move(i, 1)} className="rounded px-1 text-zinc-400 hover:bg-zinc-700 disabled:opacity-30">
                      ↓
                    </button>
                  </span>
                  <span className="min-w-0 truncate font-medium">
                    {r.name || <em className="text-zinc-500">unnamed</em>}
                    {!r.id ? <span className="ml-2 text-[10px] font-normal text-amber-300">new</span> : null}
                  </span>
                  <span className="truncate tabular-nums text-zinc-300">{formatDestination(r.phone)}</span>
                  <span className="text-zinc-300">{r.type === "WARM" ? "Warm" : "Cold"}</span>
                  <span className="truncate text-zinc-300">{r.callerIdMode === "CUSTOMER" ? "Customer's #" : r.staticCallerId ? formatPhone(r.staticCallerId) : "fixed (none picked)"}</span>
                  <span className="truncate text-xs text-zinc-400" title={r.whisperText || DEFAULT_WHISPER}>
                    {r.whisperOn ? r.whisperText || "default whisper" : "off"}
                  </span>
                  <span>
                    <Badge tone={r.active ? "green" : "zinc"}>{r.active ? "active" : "off"}</Badge>
                  </span>
                </div>
              );
            })}
            {t.rows.length === 0 ? <p className="text-sm text-zinc-500">No destinations yet. Agents see only the closer transfer until one is added.</p> : null}
          </div>
        </div>
      </Card>
      {panel ? <DestinationPanel key={panel.key ?? "new"} row={open} ownNumbers={ownNumbers} onClose={() => setPanel(null)} onToggleActive={onToggleActive} busy={busy} /> : null}
    </>
  );
}

function DestinationPanel({ row, ownNumbers, onClose, onToggleActive, busy }: { row: TransferDraft | null; ownNumbers: string[]; onClose: () => void; onToggleActive: (row: TransferDraft) => void; busy: boolean }) {
  const t = useRows("transfers");
  const { errors } = useEditor();
  const [form, setForm] = useState<Omit<TransferDraft, "key" | "id">>(() => (row ? { ...row } : { ...blank }));
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const err = (f: string) => (row ? errors[`transfers.${row.key}.${f}`] : undefined);
  const done = () => {
    // `active` is not the panel's: Deactivate/Activate writes it at once.
    const fields = { name: form.name, phone: form.phone, type: form.type, callerIdMode: form.callerIdMode, staticCallerId: form.staticCallerId, whisperOn: form.whisperOn, whisperText: form.whisperText };
    if (row) t.patch(row.key, fields);
    else t.add({ ...fields, active: true });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={row ? `Edit ${row.name}` : "Add destination"}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        className="flex h-full w-[420px] max-w-full flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{row ? row.name || "Destination" : "New destination"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded px-2 text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>
        <div className="space-y-3">
          <FieldBox label="Name" error={err("name")}>
            <input name="name" data-field={row ? `transfers.${row.key}.name` : undefined} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Closers desk" className={cls(err("name"))} />
          </FieldBox>
          <FieldBox label="Number" error={err("phone")}>
            <input name="phone" data-field={row ? `transfers.${row.key}.phone` : undefined} value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(305) 555-0100" className={cls(err("phone"))} />
          </FieldBox>
          <div className="grid grid-cols-2 gap-3">
            <FieldBox label="Default">
              <select name="type" value={form.type} onChange={(e) => set({ type: e.target.value === "WARM" ? "WARM" : "COLD" })} className={cls(undefined)}>
                <option value="COLD">Cold</option>
                <option value="WARM">Warm</option>
              </select>
            </FieldBox>
            <FieldBox label="Caller ID shown">
              <select name="callerIdMode" value={form.callerIdMode} onChange={(e) => set({ callerIdMode: e.target.value === "STATIC" ? "STATIC" : "CUSTOMER" })} className={cls(undefined)}>
                <option value="CUSTOMER">The customer&apos;s number</option>
                <option value="STATIC">A fixed number of ours</option>
              </select>
            </FieldBox>
          </div>
          <FieldBox label="Fixed number" error={err("staticCallerId")} hint="Used only with a fixed caller ID.">
            <select name="staticCallerId" data-field={row ? `transfers.${row.key}.staticCallerId` : undefined} value={form.staticCallerId} onChange={(e) => set({ staticCallerId: e.target.value })} className={cls(err("staticCallerId"))}>
              <option value="">—</option>
              {ownNumbers.map((n) => (
                <option key={n} value={n}>
                  {formatPhone(n)}
                </option>
              ))}
              {form.staticCallerId && !ownNumbers.includes(form.staticCallerId) ? <option value={form.staticCallerId}>{formatPhone(form.staticCallerId)} (not an active number)</option> : null}
            </select>
          </FieldBox>
          <FieldBox label="Whisper (what the destination hears before joining)">
            <textarea name="whisperText" rows={3} value={form.whisperText} onChange={(e) => set({ whisperText: e.target.value })} placeholder={DEFAULT_WHISPER} className={cls(undefined, "text-xs")} />
          </FieldBox>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" name="whisperOn" checked={form.whisperOn} onChange={(e) => set({ whisperOn: e.target.checked })} className="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
            Whisper on
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-4">
          <button type="button" onClick={done} className="rounded-md bg-sky-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-sky-400">
            Done
          </button>
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800">
            Cancel
          </button>
          <span className="flex-1" />
          {row?.id ? (
            <button type="button" disabled={busy} onClick={() => onToggleActive(row)} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
              {row.active ? "Deactivate" : "Activate"}
            </button>
          ) : null}
          {row ? (
            <button
              type="button"
              onClick={() => {
                t.remove(row.key);
                onClose();
              }}
              className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950"
            >
              Remove
            </button>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-zinc-500">Done keeps your changes in the draft; Save campaign writes them. Deactivate/Activate acts at once.</p>
      </aside>
    </div>
  );
}
