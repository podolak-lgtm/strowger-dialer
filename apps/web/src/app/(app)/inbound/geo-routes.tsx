// Geographic routing rules: on a number (checked before its route) or on an
// IVR (used by its GEO option). Area codes beat states; a fallback catches the
// rest. The caller's state is the matched lead's when known, else their
// number's (shared/inbound/geo-route.ts).
import type { GeoRoute } from "@strowger/db";
import { formatPhone } from "@strowger/shared";
import { Button, inputClass } from "@/components/ui";
import { deleteGeoRoute, saveGeoRoute } from "./actions";

type Opt = { id: string; name: string };
const cell = `${inputClass} py-1 text-xs`;

export function GeoRoutes({ routes, numbers, ivrs, queues }: { routes: GeoRoute[]; numbers: Array<{ id: string; phone: string }>; ivrs: Opt[]; queues: Opt[] }) {
  return (
    <div className="space-y-2">
      <div className="hidden grid-cols-[1.3fr_1fr_1fr_1fr_1.2fr_60px_70px_auto] gap-1 px-1 text-[11px] uppercase tracking-wide text-zinc-500 lg:grid">
        <span>On</span>
        <span>Name</span>
        <span>States</span>
        <span>Area codes</span>
        <span>To queue</span>
        <span>Order</span>
        <span>Fallback</span>
        <span />
      </div>
      {[...routes, null].map((r) => (
        <form key={r?.id ?? "new"} action={saveGeoRoute} className={`grid grid-cols-1 items-center gap-1 rounded-md border p-1 lg:grid-cols-[1.3fr_1fr_1fr_1fr_1.2fr_60px_70px_auto] ${r ? "border-zinc-800" : "border-dashed border-zinc-800"}`}>
          {r ? <input type="hidden" name="id" value={r.id} /> : null}
          <select name="attach" defaultValue={r ? (r.numberId ? `number:${r.numberId}` : `ivr:${r.ivrId}`) : ""} className={cell} required>
            <option value="">— number or IVR —</option>
            <optgroup label="Numbers (before their route)">
              {numbers.map((n) => (
                <option key={n.id} value={`number:${n.id}`}>
                  {formatPhone(n.phone)}
                </option>
              ))}
            </optgroup>
            <optgroup label="IVRs (their GEO option)">
              {ivrs.map((i) => (
                <option key={i.id} value={`ivr:${i.id}`}>
                  IVR: {i.name}
                </option>
              ))}
            </optgroup>
          </select>
          <input name="name" defaultValue={r?.name ?? ""} placeholder={r ? "" : "New rule"} className={cell} />
          <input name="states" defaultValue={r?.states.join(", ") ?? ""} placeholder="TX, OK" className={`${cell} font-mono`} />
          <input name="areaCodes" defaultValue={r?.areaCodes.join(", ") ?? ""} placeholder="512, 737" className={`${cell} font-mono`} />
          <select name="targetQueueId" defaultValue={r?.targetQueueId ?? ""} className={cell} required>
            <option value="">— queue —</option>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
          <input name="sortOrder" type="number" min="0" max="999" defaultValue={r?.sortOrder ?? 0} className={cell} />
          <label className="flex items-center gap-1 text-xs text-zinc-300">
            <input type="checkbox" name="isFallback" defaultChecked={r?.isFallback ?? false} className="h-3.5 w-3.5" /> rest
          </label>
          <div className="flex gap-1">
            <Button type="submit" variant="ghost">
              {r ? "Save" : "Add"}
            </Button>
            {r ? (
              <Button type="submit" variant="danger" formAction={deleteGeoRoute}>
                ✕
              </Button>
            ) : null}
          </div>
        </form>
      ))}
    </div>
  );
}
