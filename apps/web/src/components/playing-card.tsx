// Playing cards for the poker run (owner, 5 Nov: "The agent should actually
// see their cards. It should be graphical."). Pure CSS + SVG, no images:
// rank and a small pip in two corners, a large pip in the middle, red for
// hearts and diamonds, a comic-style back for an empty slot. Rules (names,
// what makes the hand) live in @strowger/shared/games.
import { cardLabel, isRed, rankGlyph } from "@strowger/shared/games";

export type CardSize = "sm" | "md" | "lg";

const SIZES: Record<CardSize, { box: string; corner: string; pip: string; cornerPip: number; radius: string }> = {
  sm: { box: "h-10 w-7", corner: "text-[10px]", pip: "h-4 w-4", cornerPip: 6, radius: "rounded-[4px]" },
  md: { box: "h-[68px] w-12", corner: "text-[13px]", pip: "h-6 w-6", cornerPip: 8, radius: "rounded-md" },
  lg: { box: "h-36 w-24", corner: "text-xl", pip: "h-12 w-12", cornerPip: 12, radius: "rounded-lg" },
};

/** Suit pips drawn in a 100×100 box. */
export function SuitPip({ suit, className = "", size }: { suit: string; className?: string; size?: number }) {
  const common = { viewBox: "0 0 100 100", className, width: size, height: size, "aria-hidden": true, fill: "currentColor" } as const;
  if (suit === "H") return <svg {...common}><path d="M50 90 C22 68 5 50 5 30 C5 15 17 5 30 5 C40 5 47 11 50 19 C53 11 60 5 70 5 C83 5 95 15 95 30 C95 50 78 68 50 90Z" /></svg>;
  if (suit === "D") return <svg {...common}><path d="M50 3 L86 50 L50 97 L14 50Z" /></svg>;
  if (suit === "S")
    return (
      <svg {...common}>
        <path d="M50 4 C36 24 8 38 8 60 C8 74 19 82 30 82 C38 82 44 78 47 72 C46 82 42 89 34 96 L66 96 C58 89 54 82 53 72 C56 78 62 82 70 82 C81 82 92 74 92 60 C92 38 64 24 50 4Z" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="50" cy="28" r="19" />
      <circle cx="27" cy="58" r="19" />
      <circle cx="73" cy="58" r="19" />
      <path d="M45 50 C45 74 41 86 33 96 L67 96 C59 86 55 74 55 50Z" />
    </svg>
  );
}

/** One card. `card` null draws the back (an empty slot). `lifted` marks a card that makes the hand. */
export function PlayingCard({ card, size = "md", lifted = false, dim = false, className = "" }: { card: string | null; size?: CardSize; lifted?: boolean; dim?: boolean; className?: string }) {
  const s = SIZES[size];
  if (!card) {
    return (
      <span role="img" aria-label="Empty slot, face down" className={`relative inline-block shrink-0 overflow-hidden border-2 border-black ${s.box} ${s.radius} bg-[#2a1f3d] shadow-[2px_2px_0_#000] ${className}`}>
        <span className="absolute inset-[3px] rounded-[3px] border border-[#f6efe0]/30 bg-[repeating-linear-gradient(45deg,#c8472b_0_3px,#2a1f3d_3px_7px)] opacity-70" />
        <span className="sw-halftone absolute inset-0" />
      </span>
    );
  }
  const red = isRed(card);
  const rank = rankGlyph(card);
  const suit = card[1] ?? "S";
  const corner = (
    <span className={`flex flex-col items-center font-black leading-none ${s.corner}`}>
      <span>{rank}</span>
      <SuitPip suit={suit} size={s.cornerPip} />
    </span>
  );
  return (
    <span
      role="img"
      aria-label={cardLabel(card)}
      title={cardLabel(card)}
      className={`sw-motion relative inline-flex shrink-0 select-none items-center justify-center border-2 bg-[#fffdf7] transition-transform ${s.box} ${s.radius} ${red ? "text-[#c8472b]" : "text-[#1b1b1f]"} ${
        lifted ? "-translate-y-1.5 border-amber-300 shadow-[2px_3px_0_#000,0_0_0_2px_rgba(252,211,77,0.6)]" : "border-black shadow-[2px_2px_0_#000]"
      } ${dim ? "opacity-45" : ""} ${className}`}
    >
      <span className="absolute left-[3px] top-[2px]">{corner}</span>
      {size === "sm" ? (
        <SuitPip suit={suit} className="absolute bottom-[3px] right-[3px] h-3 w-3" />
      ) : (
        <>
          <span className="absolute bottom-[2px] right-[3px] rotate-180">{corner}</span>
          <SuitPip suit={suit} className={s.pip} />
        </>
      )}
    </span>
  );
}

/** The agent's hand: up to five slots (faces, backs for the rest), or every card once there are more,
 *  the cards that make the hand lifted, the hand in words under it. */
export function PokerHand({ cards, best = [], makers = [], label, size = "md", slots = 5 }: { cards: string[]; best?: string[]; makers?: string[]; label?: string | null; size?: CardSize; slots?: number }) {
  const shown: (string | null)[] = cards.length >= slots ? cards : [...cards, ...Array<null>(slots - cards.length).fill(null)];
  return (
    <div>
      <div className={`flex flex-wrap items-end ${size === "sm" ? "gap-0.5" : "gap-1.5"} pt-2`} aria-label={`Your cards: ${cards.length}`}>
        {shown.map((c, i) => (
          <PlayingCard key={c ?? `empty-${i}`} card={c} size={size} lifted={c ? makers.includes(c) : false} dim={c ? cards.length > 5 && best.length > 0 && !best.includes(c) : false} />
        ))}
      </div>
      {label !== undefined ? <div className="mt-1.5 text-sm font-bold tracking-tight text-amber-200">{label ?? "No cards yet"}</div> : null}
    </div>
  );
}

export type StandingRow = { userId: string; name: string; cards: string[]; place: number; hand: { name: string; label: string; cards: string[]; makers: string[] } | null };

/** Everyone's hands on a run, as the engine ranked them (compareHands). Leader highlighted, me marked. */
export function RunLeaderboard({ rows, meId, max }: { rows: StandingRow[]; meId: string; max?: number }) {
  const list = max ? rows.slice(0, max) : rows;
  if (rows.length === 0) return <div className="text-xs text-zinc-500">Nobody has a card yet.</div>;
  return (
    <ol className="space-y-1">
      {list.map((r) => {
        const lead = r.place === 1;
        const mine = r.userId === meId;
        const best = r.hand?.cards ?? r.cards;
        return (
          <li
            key={r.userId}
            className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md border px-2 py-1.5 ${lead ? "sw-halftone-red border-amber-300/70 bg-amber-400/10" : mine ? "border-emerald-400/40 bg-emerald-400/10" : "border-white/5 bg-white/5"}`}
          >
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 border-black text-[11px] font-black ${lead ? "bg-amber-300 text-black" : "bg-zinc-800 text-zinc-200"}`}>{r.place}</span>
            <span className="min-w-[9rem] flex-1">
              <span className="block truncate text-sm font-semibold">
                {r.name}
                {mine ? <span className="ml-1 text-[10px] font-normal uppercase text-emerald-300">you</span> : null}
                {lead ? <span className="ml-1 text-[10px] font-normal uppercase text-amber-300">leader</span> : null}
              </span>
              <span className="block truncate text-[11px] text-zinc-400">
                {r.hand?.label ?? "—"} · {r.cards.length} card{r.cards.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="ml-auto flex shrink-0 gap-0.5 pt-1.5">
              {best.map((c) => (
                <PlayingCard key={c} card={c} size="sm" lifted={r.hand?.makers.includes(c) ?? false} />
              ))}
            </span>
          </li>
        );
      })}
      {max && rows.length > max ? <li className="text-[11px] text-zinc-500">and {rows.length - max} more</li> : null}
    </ol>
  );
}
