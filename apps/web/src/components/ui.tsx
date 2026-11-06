// Small, boring primitives so pages read the same. No component library yet.
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-zinc-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children, className = "", id }: { title?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`rounded-lg border border-zinc-800 bg-zinc-900 p-5 ${className}`}>
      {title ? <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-zinc-300">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? <span className="mt-1 block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";

export function Button({ children, variant = "primary", ...rest }: { children: ReactNode; variant?: "primary" | "ghost" | "danger" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: "bg-zinc-100 text-zinc-900 hover:bg-white",
    ghost: "border border-zinc-700 text-zinc-200 hover:bg-zinc-800",
    danger: "border border-red-900 text-red-300 hover:bg-red-950",
  }[variant];
  return (
    <button {...rest} className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${styles} ${rest.className ?? ""}`}>
      {children}
    </button>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "green" | "amber" | "red" | "blue" }) {
  const t = {
    zinc: "bg-zinc-800 text-zinc-300",
    green: "bg-emerald-950 text-emerald-300",
    amber: "bg-amber-950 text-amber-300",
    red: "bg-red-950 text-red-300",
    blue: "bg-sky-950 text-sky-300",
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${t}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">{children}</div>;
}

export function Notice({ kind, children }: { kind: "ok" | "warn" | "error"; children: ReactNode }) {
  const t = { ok: "border-emerald-900 bg-emerald-950/50 text-emerald-200", warn: "border-amber-900 bg-amber-950/50 text-amber-200", error: "border-red-900 bg-red-950/50 text-red-200" }[kind];
  return <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${t}`}>{children}</div>;
}
