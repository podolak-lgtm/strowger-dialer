"use client";
// "Test the prompt": one sample caller line through the queue's AI settings as
// they stand in the form (saved or not), text only, so the owner can tune the
// instructions without calling. The engine applies the same fixed rules,
// instructions, knowledge and tools as a live call.
import { useState, useTransition } from "react";
import { testAiPrompt, type AiTestResult } from "./actions";

export function AiPromptTest() {
  const [line, setLine] = useState("Hi, what are your hours on Saturday?");
  const [result, setResult] = useState<AiTestResult | null>(null);
  const [pending, start] = useTransition();

  const run = (button: HTMLButtonElement) => {
    const form = button.form;
    if (!form) return;
    const fd = new FormData(form);
    fd.set("testLine", line);
    start(async () => setResult(await testAiPrompt(fd)));
  };

  return (
    <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2">
      <div className="mb-1 text-xs font-semibold text-violet-200">Test the prompt</div>
      <p className="mb-2 text-xs text-zinc-500">Type what a caller might say. The reply uses this form as it is now, saved or not. Text only: no call is made.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={line} onChange={(e) => setLine(e.target.value)} maxLength={1000} className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm" aria-label="Sample caller line" />
        <button type="button" disabled={pending || !line.trim()} onClick={(e) => run(e.currentTarget)} className="rounded-md bg-violet-500/80 px-3 py-1 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
          {pending ? "Asking…" : "Try it"}
        </button>
      </div>
      {result ? (
        <div className="mt-2 space-y-1 text-sm">
          {result.ok ? (
            <>
              <div className="text-xs text-zinc-500">
                Opens with: <span className="text-zinc-300">“{result.opening}”</span>
              </div>
              {result.handoffPhrase ? (
                <div className="text-amber-200">Hand-off phrase “{result.handoffPhrase}”: on a call the caller goes straight to a person, before the AI answers.</div>
              ) : (
                <div className="whitespace-pre-wrap rounded bg-black/30 px-2 py-1 text-zinc-100">{result.reply || <span className="text-zinc-500">(no words, only a tool call)</span>}</div>
              )}
              {result.tools.map((t, i) => (
                <div key={i} className="font-mono text-xs text-sky-300">
                  would call {t.name}({JSON.stringify(t.input)})
                </div>
              ))}
            </>
          ) : (
            <div className="text-red-300">{result.error}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
