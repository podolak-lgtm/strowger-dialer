"use client";

// The poker run's rule as both run forms post it (campaign Games tab and
// /games): what deals a card, and "Deal a card every N <qualifying outcomes>"
// (seven-card stud, owner 6 Nov). N follows the qualifier's default until the
// person types their own. Rules in @strowger/shared/games.
import { HAND_MAX, POKER_QUALIFIERS, clampOutcomesPerCard, defaultOutcomesPerCard, outcomeNoun } from "@strowger/shared/games";
import { useState } from "react";

export function PokerRuleFields({ inputClass, labelClass = "text-zinc-400", codesPlaceholder = "SALE, XFER", codesListId }: { inputClass: string; labelClass?: string; codesPlaceholder?: string; codesListId?: string }) {
  const [q, setQ] = useState("SALE");
  const [codes, setCodes] = useState("");
  const [n, setN] = useState<string | null>(null);
  const value = n ?? String(defaultOutcomesPerCard(q));
  const per = clampOutcomesPerCard(value);
  const codeList = codes.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  const unit = q === "CONTACT" ? "live contacts" : q === "CODES" ? "qualifying dispositions" : "sales";
  return (
    <>
      <label className="block">
        <span className={labelClass}>What deals a card</span>
        <select name="qualifies" value={q} onChange={(e) => setQ(e.target.value)} className={inputClass}>
          {Object.entries(POKER_QUALIFIERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={labelClass}>Deal a card every N {unit}</span>
        <input name="outcomesPerCard" type="number" min={1} max={100} step={1} value={value} onChange={(e) => setN(e.target.value)} className={inputClass} />
      </label>
      <label className="col-span-2 block">
        <span className={labelClass}>Disposition codes (for &ldquo;These disposition codes&rdquo;)</span>
        <input name="codes" value={codes} onChange={(e) => setCodes(e.target.value)} list={codesListId} placeholder={codesPlaceholder} className={inputClass} />
      </label>
      <p className="col-span-2 text-xs text-zinc-500">
        Seven-card stud: a card for every {outcomeNoun(q, per, q === "CODES" ? codeList : [])}, up to {HAND_MAX} cards each; the best five win. {per > 1 ? "The next locked slot fills its ring as they get closer." : "Use a higher number when outcomes come often, so the hand lasts the whole run."}
      </p>
    </>
  );
}
