"use client";

// Lists & dial plans, Dispositions, CRM push: compact inline-edit tables.
// Adds and removes go into the draft; only Test (webhook) acts at once.
import { useState, useTransition } from "react";
import { WEBHOOK_EVENTS } from "@strowger/shared/campaign-form";
import { Badge } from "@/components/ui";
import { NavLink } from "@/components/nav-link";
import { testWebhook } from "../webhook-actions";
import { AddButton, Card, Hint, RemoveButton, RowCheck, RowInput, StackLabel, cls, useEditor, useRows } from "./editor-ui";

export interface ListInfo {
  id: string;
  name: string;
  priority: number;
  totalLeads: number;
  dialableLeads: number;
  status: string;
  /** The campaign it sits on now, when not this one. */
  elsewhere: string | null;
}

const th = "text-[10px] font-medium uppercase tracking-wide text-zinc-500";

export function ListsTab({ lists }: { lists: ListInfo[] }) {
  const { draft, edit } = useEditor();
  const byId = new Map(lists.map((l) => [l.id, l]));
  const attached = draft.lists.map((id) => byId.get(id)).filter((l): l is ListInfo => Boolean(l));
  const available = lists.filter((l) => !draft.lists.includes(l.id));
  const [pick, setPick] = useState("");
  const chosen = available.some((l) => l.id === pick) ? pick : (available[0]?.id ?? "");
  const plans = useRows("dialPlans");
  const planCols = "@min-[460px]:grid-cols-[minmax(0,1fr)_54px_54px_54px_70px_64px_24px]";
  const hide = "@min-[460px]:hidden";

  return (
    <>
      <Card
        title={`Lists in this campaign (${attached.length})`}
        actions={
          available.length ? (
            <>
              <select aria-label="List to attach" value={chosen} onChange={(e) => setPick(e.target.value)} className={cls(undefined, "w-44 py-1 text-xs")}>
                {available.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.elsewhere ? ` (on ${l.elsewhere})` : ""}
                  </option>
                ))}
              </select>
              <AddButton onClick={() => chosen && edit((d) => ({ ...d, lists: [...d.lists, chosen] }))}>+ Attach list</AddButton>
            </>
          ) : null
        }
      >
        {attached.length === 0 ? (
          <p className="text-sm text-zinc-500">
            None. Attach one above, or assign lists from the{" "}
            <NavLink href="/lists" className="underline">
              Lists
            </NavLink>{" "}
            page.
          </p>
        ) : (
          <div className="@container">
            <div className={`hidden gap-2 px-1 pb-1 @min-[420px]:grid @min-[420px]:grid-cols-[minmax(0,1fr)_72px_72px_64px_24px] ${th}`}>
              <span>List</span>
              <span className="text-right">Leads</span>
              <span className="text-right">Dialable</span>
              <span>Status</span>
              <span />
            </div>
            <div className="space-y-1.5 @min-[420px]:space-y-0 @min-[420px]:divide-y @min-[420px]:divide-zinc-800">
              {attached.map((l) => (
                <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-md border border-zinc-800 p-2 text-sm @min-[420px]:grid-cols-[minmax(0,1fr)_72px_72px_64px_24px] @min-[420px]:rounded-none @min-[420px]:border-0 @min-[420px]:px-1 @min-[420px]:py-1.5">
                  <span className="min-w-0 truncate">
                    <NavLink href={`/lists/${l.id}`} className="hover:underline">
                      {l.name}
                    </NavLink>
                    <span className="ml-2 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">P{l.priority}</span>
                    {l.elsewhere ? <span className="ml-2 text-[10px] text-amber-300">moves from {l.elsewhere} on Save</span> : null}
                  </span>
                  <span className="text-right tabular-nums text-zinc-300 @max-[419px]:hidden">{l.totalLeads.toLocaleString()}</span>
                  <span className="text-right tabular-nums text-zinc-300 @max-[419px]:hidden">{l.dialableLeads.toLocaleString()}</span>
                  <span className="@max-[419px]:hidden">
                    <Badge tone={l.status === "ACTIVE" ? "green" : "amber"}>{l.status}</Badge>
                  </span>
                  <RemoveButton label={`Detach ${l.name}`} onClick={() => edit((d) => ({ ...d, lists: d.lists.filter((x) => x !== l.id) }))} />
                  <span className="col-span-2 text-xs text-zinc-500 @min-[420px]:hidden">
                    {l.totalLeads.toLocaleString()} leads · {l.dialableLeads.toLocaleString()} dialable · {l.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card
        title={`Dial plans by lead age (${plans.rows.length})`}
        actions={<AddButton onClick={() => plans.add({ leadType: "", ageFromDays: "0", ageToDays: "", attemptsPerDay: "3", retryGapMinutes: "180", weight: "0" })}>+ Add</AddButton>}
      >
        <Hint more="How often a lead is tried depending on how old it is (days since it was posted) and its lead type. Empty “To” means no upper age; empty lead type means any. Higher weight is dialled earlier when the hopper orders by dial-plan weight. The state's cap always wins.">How often a lead is tried by age. The state&apos;s cap always wins.</Hint>
        <div className="mt-2 @container">
          <div className={`hidden gap-1.5 px-1 pb-1 @min-[460px]:grid ${planCols} ${th}`}>
            <span>Lead type</span>
            <span>From d</span>
            <span>To d</span>
            <span>Per day</span>
            <span>Gap min</span>
            <span>Weight</span>
            <span />
          </div>
          <div className="space-y-1.5">
            {plans.rows.map((p) => (
              <div key={p.key} className={`grid grid-cols-3 items-end gap-1.5 rounded-md border border-zinc-800 p-2 @min-[460px]:items-center @min-[460px]:border-0 @min-[460px]:p-0 ${planCols}`}>
                <label className="col-span-3 @min-[460px]:col-span-1">
                  <StackLabel hide={hide}>Lead type</StackLabel>
                  <RowInput coll="dialPlans" row={p} f="leadType" label="Lead type" placeholder="any" />
                </label>
                <label>
                  <StackLabel hide={hide}>From d</StackLabel>
                  <RowInput coll="dialPlans" row={p} f="ageFromDays" label="From days" type="number" min="0" />
                </label>
                <label>
                  <StackLabel hide={hide}>To d</StackLabel>
                  <RowInput coll="dialPlans" row={p} f="ageToDays" label="To days" type="number" min="0" placeholder="∞" />
                </label>
                <label>
                  <StackLabel hide={hide}>Per day</StackLabel>
                  <RowInput coll="dialPlans" row={p} f="attemptsPerDay" label="Attempts per day" type="number" min="1" max="10" />
                </label>
                <label>
                  <StackLabel hide={hide}>Gap min</StackLabel>
                  <RowInput coll="dialPlans" row={p} f="retryGapMinutes" label="Retry gap minutes" type="number" min="5" />
                </label>
                <label>
                  <StackLabel hide={hide}>Weight</StackLabel>
                  <RowInput coll="dialPlans" row={p} f="weight" label="Weight" type="number" />
                </label>
                <div className="flex justify-end">
                  <RemoveButton label="Remove dial plan" onClick={() => plans.remove(p.key)} />
                </div>
              </div>
            ))}
            {plans.rows.length === 0 ? <p className="text-sm text-zinc-500">No dial plans: the campaign default attempts apply.</p> : null}
          </div>
        </div>
      </Card>
    </>
  );
}

export function DispositionsTab() {
  const d = useRows("dispositions");
  const cols = "@min-[700px]:grid-cols-[84px_minmax(0,1fr)_44px_repeat(4,56px)_70px_28px]";
  const hide = "@min-[700px]:hidden";
  return (
    <Card
      title={`Dispositions (${d.rows.length})`}
      className="min-[900px]:col-span-2"
      actions={<AddButton onClick={() => d.add({ code: "", label: "", hotkey: "", isContact: false, isSale: false, isCallback: false, isDnc: false, recycleAfterMinutes: "", active: true })}>+ Add</AddButton>}
    >
      <Hint more="Key is the console hotkey. Recycle after: minutes before the lead is dialled again; empty means the lead is finished. Removing a code that calls already used switches it off instead of deleting it, so reports keep it.">
        Codes agents pick after a call.
      </Hint>
      <div className="mt-2 @container">
        <div className={`hidden gap-1.5 px-1 pb-1 @min-[700px]:grid ${cols} ${th}`}>
          <span>Code</span>
          <span>Label</span>
          <span>Key</span>
          <span className="text-center">Contact</span>
          <span className="text-center">Sale</span>
          <span className="text-center">Callback</span>
          <span className="text-center">DNC</span>
          <span>Recycle</span>
          <span />
        </div>
        <div className="grid gap-1.5">
          {d.rows.map((r) => (
            <div key={r.key} className={`grid grid-cols-[84px_minmax(0,1fr)_44px] items-center gap-1.5 rounded-md border border-zinc-800 p-2 @min-[700px]:border-0 @min-[700px]:p-0 ${cols} ${r.active ? "" : "opacity-60"}`}>
              <RowInput coll="dispositions" row={r} f="code" label="Code" placeholder="CODE" className="font-mono uppercase" />
              <RowInput coll="dispositions" row={r} f="label" label="Label" placeholder="New disposition" />
              <RowInput coll="dispositions" row={r} f="hotkey" label="Hotkey" maxLength={1} className="text-center" />
              <div className="col-span-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400 @min-[700px]:contents">
                {(
                  [
                    ["isContact", "Contact"],
                    ["isSale", "Sale"],
                    ["isCallback", "Callback"],
                    ["isDnc", "DNC"],
                  ] as const
                ).map(([f, label]) => (
                  <label key={f} className="flex items-center gap-1 @min-[700px]:justify-center">
                    <RowCheck coll="dispositions" row={r} f={f} label={label} />
                    <span className={hide}>{label}</span>
                  </label>
                ))}
                <label className="flex items-center gap-1">
                  <span className={hide}>Recycle</span>
                  <RowInput coll="dispositions" row={r} f="recycleAfterMinutes" label="Recycle after (min)" type="number" min="1" placeholder="final" className="w-[70px]" />
                </label>
                <div className="ml-auto flex items-center @min-[700px]:ml-0 @min-[700px]:justify-end">
                  {r.active ? (
                    <RemoveButton label={`Remove ${r.code || "disposition"}`} onClick={() => d.remove(r.key)} />
                  ) : (
                    <button type="button" title="Switched off (kept for call history). Click to switch it back on." onClick={() => d.patch(r.key, { active: true })} className="rounded px-1 text-[10px] text-amber-300 hover:bg-zinc-800">
                      off ↺
                    </button>
                  )}
                </div>
              </div>
              {d.rowHasError(r.key) ? <div className="col-span-full text-xs text-red-400">{d.errorOf(r.key, "code") ?? d.errorOf(r.key, "label")}</div> : null}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export interface WebhookInfo {
  secretPrefix: string;
  last: { status: string; error: string | null } | null;
}

export function CrmTab({ info }: { info: Record<string, WebhookInfo> }) {
  const w = useRows("webhooks");
  const [testing, startTest] = useTransition();
  const [tested, setTested] = useState<string | null>(null);
  return (
    <Card
      title={`CRM push: webhooks (${w.rows.length})`}
      className="min-[900px]:col-span-2"
      actions={<AddButton onClick={() => w.add({ url: "", events: ["disposition"], active: true }, "end")}>+ Add endpoint</AddButton>}
    >
      <Hint
        more={
          <>
            Each disposition posts JSON to these URLs with header <code>x-strowger-signature: t=&lt;unix&gt;,v1=&lt;hex HMAC-SHA256 of &quot;t.body&quot; with the secret&gt;</code>. Failed deliveries retry with backoff for up to ten attempts. Test queues a sample delivery at once (save a new endpoint first). Unticking Active pauses an endpoint.
          </>
        }
      >
        Dispositions post signed JSON to these URLs.
      </Hint>
      <div className="mt-2 space-y-1.5">
        {w.rows.map((r) => {
          const i = r.id ? info[r.id] : undefined;
          const last = i?.last;
          return (
            <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-zinc-800 p-2 text-xs">
              <div className="min-w-[200px] flex-1 basis-[260px]">
                <RowInput coll="webhooks" row={r} f="url" label="Endpoint URL" placeholder="https://crm.example.com/strowger" className="font-mono text-xs" />
                {w.errorOf(r.key, "url") ? <div className="mt-0.5 text-red-400">{w.errorOf(r.key, "url")}</div> : null}
              </div>
              {WEBHOOK_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-1 text-zinc-300">
                  <input
                    type="checkbox"
                    aria-label={`${e} events`}
                    checked={r.events.includes(e)}
                    onChange={(ev) => w.patch(r.key, { events: ev.target.checked ? [...r.events, e] : r.events.filter((x) => x !== e) })}
                    className="h-3.5 w-3.5"
                  />
                  {e}
                </label>
              ))}
              <label className="flex items-center gap-1 text-zinc-300">
                <RowCheck coll="webhooks" row={r} f="active" label="Active" /> active
              </label>
              {i ? <span className="font-mono text-[10px] text-zinc-500">secret {i.secretPrefix}…</span> : <span className="text-[10px] text-zinc-500">secret made on Save</span>}
              {last ? <Badge tone={last.status === "DELIVERED" ? "green" : last.status === "FAILED" ? "red" : "amber"}>{`last: ${last.status.toLowerCase()}${last.error ? ` (${last.error})` : ""}`}</Badge> : null}
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  disabled={!r.id || testing}
                  title={r.id ? "Queue a sample delivery now" : "Save first"}
                  onClick={() => {
                    if (!r.id) return;
                    const fd = new FormData();
                    fd.set("id", r.id);
                    startTest(async () => {
                      await testWebhook(fd);
                      setTested(r.key);
                    });
                  }}
                  className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                >
                  {tested === r.key ? "Test queued" : "Test"}
                </button>
                <RemoveButton label="Remove endpoint" onClick={() => w.remove(r.key)} />
              </span>
            </div>
          );
        })}
        {w.rows.length === 0 ? <p className="text-sm text-zinc-500">No endpoints. Dispositions are not pushed anywhere.</p> : null}
      </div>
    </Card>
  );
}
