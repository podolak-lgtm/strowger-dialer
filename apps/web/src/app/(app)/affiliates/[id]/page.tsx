import { prisma } from "@strowger/db";
import { LEAD_FIELDS, LEAD_FIELD_LABELS, POST_REQUIRED_FIELDS } from "@strowger/shared";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { Badge, Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { rotateAffiliateKey, saveFieldMapping, setAffiliateActive, setDefaultList } from "../actions";

export default async function AffiliatePage({ params, searchParams }: PageProps<"/affiliates/[id]">) {
  const s = await requireRole("SUPERVISOR");
  const { id } = await params;
  const { key } = await searchParams;
  const a = await prisma.affiliate.findFirst({
    where: { id, tenantId: s.tenant.id },
    include: { lists: { select: { id: true, name: true, totalLeads: true } } },
  });
  if (!a) notFound();

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://web-production-c3af0.up.railway.app";
  const shownKey = typeof key === "string" ? key : null;
  const mapping = (a.fieldMapping ?? {}) as Record<string, string>;
  const mappingText = Object.entries(mapping)
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");

  const example = {
    first_name: "Ada",
    last_name: "Lovelace",
    phone: "3055552368",
    address: "1 Ocean Dr",
    city: "Miami",
    state: "FL",
    zip: "33139",
    email: "ada@example.com",
    jornaya_lead_id: "F1A2B3C4-…",
    trustedform_cert_url: "https://cert.trustedform.com/…",
    opt_in_url: "https://yoursite.com/quote",
    opt_in_at: "2026-11-04T18:22:00Z",
    opt_in_ip: "203.0.113.9",
    lead_type: "fresh",
  };

  return (
    <div>
      <PageHeader
        title={a.name}
        subtitle={
          <>
            Key <span className="font-mono">{a.apiKeyHint}</span> · {a.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Disabled</Badge>}
          </>
        }
        actions={
          <>
            <form action={rotateAffiliateKey}>
              <input type="hidden" name="id" value={a.id} />
              <Button variant="ghost" type="submit">
                Rotate key
              </Button>
            </form>
            <form action={setAffiliateActive}>
              <input type="hidden" name="id" value={a.id} />
              <input type="hidden" name="active" value={a.active ? "false" : "true"} />
              <Button variant={a.active ? "danger" : "primary"} type="submit">
                {a.active ? "Disable" : "Enable"}
              </Button>
            </form>
          </>
        }
      />

      {shownKey ? (
        <Notice kind="warn">
          <div className="font-medium">This key is shown once. Copy it now.</div>
          <code className="mt-1 block select-all break-all font-mono text-sm">{shownKey}</code>
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Posting instructions" className="lg:row-span-2">
          <div className="space-y-4 text-sm text-zinc-300">
            <p>
              Send one lead per request to <code className="font-mono">POST {base}/api/v1/leads</code> with header{" "}
              <code className="font-mono">Authorization: Bearer YOUR_KEY</code>. JSON or form-encoded. The response is immediate.
            </p>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Fields</div>
              <table className="w-full text-xs">
                <tbody className="divide-y divide-zinc-800">
                  {LEAD_FIELDS.map((f) => (
                    <tr key={f}>
                      <td className="py-1 pr-3 font-mono">{f}</td>
                      <td className="py-1 pr-3 text-zinc-400">{LEAD_FIELD_LABELS[f]}</td>
                      <td className="py-1 text-right">{POST_REQUIRED_FIELDS.includes(f) ? <Badge tone="amber">required</Badge> : <Badge>optional</Badge>}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1 pr-3 font-mono">list_id</td>
                    <td className="py-1 pr-3 text-zinc-400">Which of your lists; defaults to your main list</td>
                    <td className="py-1 text-right">
                      <Badge>optional</Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-xs text-zinc-500">
                One of <code>jornaya_lead_id</code> or <code>trustedform_cert_url</code> should be present; both are stored with the lead as consent evidence. Any other
                field is kept as custom data.
              </p>
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Example</div>
              <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed">
                {`curl -X POST ${base}/api/v1/leads \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(example, null, 2).replace(/\n/g, "\n  ")}'`}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Responses</div>
              <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-relaxed">{`201 {"status":"accepted","lead_id":"…"}
200 {"status":"duplicate","lead_id":"…","action":"reject|accept|update"}
422 {"status":"rejected","reason":"bad_phone|missing_fields|dnc|invalid","detail":"…"}
401 {"status":"error","error":"invalid_api_key"}`}</pre>
            </div>
          </div>
        </Card>

        <Card title="Field mapping">
          <form action={saveFieldMapping} className="space-y-3">
            <input type="hidden" name="id" value={a.id} />
            <Field label="Their field = our field, one per line" hint="Use this when the affiliate cannot rename their fields. Example: fname = first_name">
              <textarea name="mapping" rows={6} defaultValue={mappingText} className={`${inputClass} font-mono`} placeholder={"fname = first_name\nlname = last_name\nphone_number = phone"} />
            </Field>
            <Button type="submit">Save mapping</Button>
          </form>
        </Card>

        <Card title="Lists">
          <form action={setDefaultList} className="space-y-3">
            <input type="hidden" name="id" value={a.id} />
            <Field label="Default list (used when no list_id is posted)">
              <select name="listId" defaultValue={a.defaultListId ?? ""} className={inputClass}>
                {a.lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.totalLeads})
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="ghost">
              Save
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
