"use client";

// Live view of a Free Caller Registry run: polls the engine's progress every
// few seconds and shows each step as it happens, then the result.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { registryProgress, type FcrProgress } from "@/app/(app)/dids/hygiene-actions";

const STEPS = ["starting", "open", "send code", "read code", "verify", "business details", "upload numbers", "submit", "done"];

export function FcrProgressView({ initial }: { initial: FcrProgress | null }) {
  const [p, setP] = useState<FcrProgress | null>(initial);
  const router = useRouter();
  useEffect(() => {
    if (!p || p.state !== "running") return;
    const t = setInterval(() => {
      void registryProgress().then((next) => {
        setP(next);
        if (next && next.state !== "running") router.refresh();
      });
    }, 4000);
    return () => clearInterval(t);
  }, [p, router]);
  if (!p) return null;
  const idx = STEPS.indexOf(p.step);
  const tone = p.state === "done" ? "border-emerald-700 bg-emerald-950/40" : p.state === "failed" ? "border-red-800 bg-red-950/40" : "border-sky-800 bg-sky-950/40";
  return (
    <div className={`mb-3 rounded-md border p-3 text-sm ${tone}`}>
      <div className="flex items-center gap-3">
        {p.state === "running" ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-300 border-t-transparent" /> : <span>{p.state === "done" ? "✓" : "✕"}</span>}
        <span className="font-medium">{p.state === "running" ? `Registering… step ${Math.max(1, idx)} of ${STEPS.length - 1}: ${p.step}` : p.state === "done" ? "Registered" : "Registration stopped"}</span>
        <span className="text-xs text-zinc-500">started {new Date(p.startedAt).toLocaleTimeString()}</span>
      </div>
      {p.state === "running" ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-black/30">
          <div className="h-full bg-sky-400 transition-all" style={{ width: `${Math.round((Math.max(0, idx) / (STEPS.length - 1)) * 100)}%` }} />
        </div>
      ) : null}
      <ul className="mt-2 space-y-0.5 text-xs text-zinc-300">
        {p.log.map((l, i) => (
          <li key={i}>
            <span className="text-zinc-500">{new Date(l.at).toLocaleTimeString()}</span> · {l.line}
          </li>
        ))}
      </ul>
    </div>
  );
}
