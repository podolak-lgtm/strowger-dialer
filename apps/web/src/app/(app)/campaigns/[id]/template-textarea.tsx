"use client";

import { useRef, useState } from "react";
import { Button, inputClass } from "@/components/ui";

type Option = { key: string; name: string; text: string };

/**
 * A textarea with a "Load a template" picker above it. Loading replaces the
 * textarea's contents; nothing is saved until the surrounding form's Save
 * button is pressed, so a supervisor can edit the template first.
 */
export function TemplateTextarea({
  name,
  rows,
  defaultValue,
  placeholder,
  options,
  loadLabel,
}: {
  name: string;
  rows: number;
  defaultValue: string;
  placeholder?: string;
  options: Option[];
  loadLabel: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState(options[0]?.key ?? "");
  const [loaded, setLoaded] = useState<string | null>(null);

  function load() {
    const t = options.find((o) => o.key === picked);
    const el = ref.current;
    if (!t || !el) return;
    if (el.value.trim() && el.value !== t.text && !window.confirm("Replace what is in the box with the template? Nothing is saved until you press Save.")) return;
    el.value = t.text;
    el.focus();
    setLoaded(t.name);
  }

  return (
    <div className="space-y-2">
      {options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${name}-template`} className="text-xs text-zinc-500">
            Load a template
          </label>
          <select id={`${name}-template`} value={picked} onChange={(e) => setPicked(e.target.value)} className={`${inputClass} w-auto py-1 text-xs`}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
          <Button type="button" variant="ghost" onClick={load} className="py-1 text-xs">
            {loadLabel}
          </Button>
          {loaded ? <span className="text-xs text-zinc-500">Loaded “{loaded}”. Edit as needed, then Save.</span> : null}
        </div>
      ) : null}
      <textarea ref={ref} name={name} rows={rows} defaultValue={defaultValue} placeholder={placeholder} className={`${inputClass} font-mono text-xs`} />
    </div>
  );
}
