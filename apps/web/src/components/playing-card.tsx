// Playing cards for the poker run (owner, 5 Nov: "The agent should actually
// see their cards. It should be graphical."; 6 Nov: "7 card, use this style
// graphics, more sexy!"). One SVG per face on a 250 × 350 board, no images:
// rank and suit in two corners (the lower one turned 180°), the classic pip
// layout for 2 to 10, one large pip on an ace, and our own drawn court figure
// (double-headed, red / blue / gold) on J, Q and K. Red for hearts and
// diamonds, black for spades and clubs. Rules (names, what makes the hand)
// live in @strowger/shared/games.
import { cardLabel, isRed, rankGlyph } from "@strowger/shared/games";
import { useId } from "react";

export type CardSize = "sm" | "md" | "lg" | "fluid";

const WIDTH: Record<CardSize, string> = { sm: "w-7", md: "w-12", lg: "w-24", fluid: "w-full" };
const RED = "#d0263a";
const BLACK = "#16161a";

/** A suit pip drawn in a 100 × 100 box. */
function PipShape({ suit }: { suit: string }) {
  if (suit === "H") return <path d="M50 92 C22 70 4 52 4 30 C4 14 16 4 30 4 C40 4 47 10 50 19 C53 10 60 4 70 4 C84 4 96 14 96 30 C96 52 78 70 50 92Z" />;
  if (suit === "D") return <path d="M50 2 C58 18 72 36 88 50 C72 64 58 82 50 98 C42 82 28 64 12 50 C28 36 42 18 50 2Z" />;
  if (suit === "S") return <path d="M50 3 C38 22 6 38 6 61 C6 75 17 84 30 84 C38 84 44 80 47 74 C46 84 42 91 32 97 L68 97 C58 91 54 84 53 74 C56 80 62 84 70 84 C83 84 94 75 94 61 C94 38 62 22 50 3Z" />;
  return (
    <>
      <circle cx="50" cy="27" r="20" />
      <circle cx="26" cy="58" r="20" />
      <circle cx="74" cy="58" r="20" />
      <path d="M45 50 C45 76 41 88 31 97 L69 97 C59 88 55 76 55 50Z" />
    </>
  );
}

/** Suit pip as its own small SVG (kept for chips and labels). */
export function SuitPip({ suit, className = "", size }: { suit: string; className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 100 100" className={className} width={size} height={size} aria-hidden fill="currentColor">
      <PipShape suit={suit} />
    </svg>
  );
}

/** A pip placed on the 250 × 350 board, centred on (x, y); pips in the lower half are turned over. */
function Pip({ suit, x, y, size, flip = false }: { suit: string; x: number; y: number; size: number; flip?: boolean }) {
  const k = size / 100;
  return (
    <g transform={`translate(${x} ${y}) ${flip ? "rotate(180)" : ""} scale(${k}) translate(-50 -50)`}>
      <PipShape suit={suit} />
    </g>
  );
}

// Classic pip arrangement: columns and rows on the 250 × 350 board.
const L = 80;
const C = 125;
const R = 170;
const TOP = 78;
const BOT = 272;
const MID = 175;
const Q1 = TOP + (BOT - TOP) / 3; // 9 and 10: four rows
const Q2 = TOP + (2 * (BOT - TOP)) / 3;
const PIPS: Record<string, [number, number][]> = {
  "2": [[C, TOP], [C, BOT]],
  "3": [[C, TOP], [C, MID], [C, BOT]],
  "4": [[L, TOP], [R, TOP], [L, BOT], [R, BOT]],
  "5": [[L, TOP], [R, TOP], [C, MID], [L, BOT], [R, BOT]],
  "6": [[L, TOP], [R, TOP], [L, MID], [R, MID], [L, BOT], [R, BOT]],
  "7": [[L, TOP], [R, TOP], [C, (TOP + MID) / 2], [L, MID], [R, MID], [L, BOT], [R, BOT]],
  "8": [[L, TOP], [R, TOP], [C, (TOP + MID) / 2], [L, MID], [R, MID], [C, (MID + BOT) / 2], [L, BOT], [R, BOT]],
  "9": [[L, TOP], [R, TOP], [L, Q1], [R, Q1], [C, MID], [L, Q2], [R, Q2], [L, BOT], [R, BOT]],
  T: [[L, TOP], [R, TOP], [C, (TOP + Q1) / 2], [L, Q1], [R, Q1], [L, Q2], [R, Q2], [C, (Q2 + BOT) / 2], [L, BOT], [R, BOT]],
};

/** Rank over a small pip, as printed in the top-left corner. */
function Corner({ rank, suit }: { rank: string; suit: string }) {
  return (
    <g>
      <text x="26" y="50" textAnchor="middle" fontSize={rank === "10" ? 38 : 44} fontWeight={800} letterSpacing={rank === "10" ? -4 : 0} fontFamily="Georgia, 'Times New Roman', serif">
        {rank}
      </text>
      <Pip suit={suit} x={26} y={72} size={26} />
    </g>
  );
}

const SKIN = "#f6d7b0";
const INK = "#3b2414";
const GOLD = "#e9b52b";
const GOLD_DARK = "#b9861a";
const BLUE = "#2346a8";
const CRIMSON = "#c8283c";

/** The top half of a court figure on the board (x 50..200, y 46..175); the card shows it twice, turned. */
function CourtHalf({ rank, suit, red }: { rank: string; suit: string; red: boolean }) {
  const primary = red ? CRIMSON : BLUE;
  const accent = red ? BLUE : CRIMSON;
  const hair = rank === "Q" ? "#f2c94c" : rank === "K" ? "#d9d2c3" : "#8a5a2b";
  return (
    <g stroke={INK} strokeWidth={1.4} strokeLinejoin="round">
      {/* What they hold, behind the robe */}
      {rank === "K" ? (
        <g>
          <path d="M166 58 L172 52 L178 58 L178 150 L166 150Z" fill="#dfe5ec" />
          <path d="M156 146 L188 146 L188 153 L156 153Z" fill={GOLD} />
        </g>
      ) : rank === "J" ? (
        <g>
          <path d="M78 56 L82 56 L82 175 L78 175Z" fill={GOLD_DARK} />
          <path d="M82 60 Q100 66 98 84 Q90 76 82 78Z" fill="#dfe5ec" />
        </g>
      ) : (
        <g>
          <path d="M80 175 L86 120" fill="none" stroke="#2f7d32" strokeWidth={3} />
          <circle cx="86" cy="114" r="9" fill={accent} />
          <circle cx="86" cy="114" r="3.5" fill={GOLD} />
        </g>
      )}
      {/* Robe */}
      <path d="M54 175 L60 148 Q72 128 98 124 L152 124 Q178 128 190 148 L196 175Z" fill={primary} />
      <path d="M106 124 L144 124 L150 175 L100 175Z" fill={GOLD} />
      <path d="M103 138 L147 138 L148 145 L102 145Z M101 156 L149 156 L150 163 L100 163Z" fill={accent} strokeWidth={1} />
      <g fill={GOLD} strokeWidth={1}>
        <circle cx="74" cy="158" r="4" />
        <circle cx="86" cy="146" r="4" />
        <circle cx="164" cy="146" r="4" />
        <circle cx="176" cy="158" r="4" />
      </g>
      {/* Collar: ermine for the king, gold for the queen, the accent for the jack */}
      <path d="M94 124 Q125 150 156 124 L150 118 Q125 138 100 118Z" fill={rank === "K" ? "#ffffff" : rank === "Q" ? GOLD : accent} />
      {rank === "K" ? (
        <g fill={INK} stroke="none">
          <circle cx="108" cy="127" r="1.6" />
          <circle cx="125" cy="133" r="1.6" />
          <circle cx="142" cy="127" r="1.6" />
        </g>
      ) : null}
      {/* Hair behind the head */}
      {rank === "Q" ? <path d="M106 86 Q98 116 110 128 L118 98Z M144 86 Q152 116 140 128 L132 98Z" fill={hair} /> : null}
      {rank === "J" ? (
        <g fill={hair}>
          <circle cx="107" cy="102" r="7" />
          <circle cx="143" cy="102" r="7" />
        </g>
      ) : null}
      {/* Neck and head */}
      <path d="M117 106 L133 106 L133 122 L117 122Z" fill={SKIN} />
      <ellipse cx="125" cy="94" rx="17" ry="20" fill={SKIN} />
      <g fill={INK} stroke="none">
        <ellipse cx="118.5" cy="92" rx="2" ry="1.6" />
        <ellipse cx="131.5" cy="92" rx="2" ry="1.6" />
      </g>
      <path d="M115 87 L121 86 M129 86 L135 87 M125 94 L123 101 L126.5 101.5" fill="none" strokeWidth={1.2} />
      <path d="M120 107 Q125 110.5 130 107" fill="none" stroke={CRIMSON} strokeWidth={1.6} />
      {rank === "K" ? <path d="M108 98 Q110 124 125 128 Q140 124 142 98 Q134 108 125 108 Q116 108 108 98Z M117 104 Q125 100 133 104 Q125 107 117 104Z" fill={hair} /> : null}
      {/* Headwear */}
      {rank === "K" ? (
        <g>
          <path d="M106 78 L104 56 L115 66 L125 49 L135 66 L146 56 L144 78Z" fill={GOLD} />
          <path d="M105 71 L145 71 L145 79 L105 79Z" fill={primary} />
          <g fill="#ffffff" strokeWidth={1}>
            <circle cx="115" cy="75" r="2.4" />
            <circle cx="125" cy="75" r="2.4" />
            <circle cx="135" cy="75" r="2.4" />
          </g>
          <g fill={GOLD} strokeWidth={1}>
            <circle cx="104" cy="55" r="3" />
            <circle cx="125" cy="48" r="3.4" />
            <circle cx="146" cy="55" r="3" />
          </g>
        </g>
      ) : rank === "Q" ? (
        <g>
          <path d="M108 80 Q107 64 112 61 Q118 70 125 59 Q132 70 138 61 Q143 64 142 80Z" fill={GOLD} />
          <path d="M107 74 L143 74 L143 80 L107 80Z" fill={accent} />
          <circle cx="125" cy="56" r="3.6" fill={primary} strokeWidth={1} />
        </g>
      ) : (
        <g>
          <path d="M146 70 Q170 48 180 60 Q164 64 150 78Z" fill="#ffffff" />
          <path d="M104 82 Q106 62 127 60 Q150 62 150 80Z" fill={accent} />
          <path d="M100 82 L153 79 L151 86 L102 88Z" fill={GOLD} />
        </g>
      )}
      {/* The suit beside the head */}
      <g fill={red ? RED : BLACK} stroke="none">
        <Pip suit={suit} x={68} y={66} size={22} />
      </g>
    </g>
  );
}

function CardFace({ card, simple }: { card: string; simple: boolean }) {
  const clip = useId();
  const red = isRed(card);
  const ink = red ? RED : BLACK;
  const r = card[0] ?? "A";
  const rank = rankGlyph(card);
  const suit = card[1] ?? "S";
  const court = r === "J" || r === "Q" || r === "K";
  return (
    <svg viewBox="0 0 250 350" className="block h-full w-full" aria-hidden>
      <rect x="0" y="0" width="250" height="350" rx="20" fill="#ffffff" />
      <g fill={ink}>
        {simple ? (
          <>
            <text x="18" y="96" fontSize={92} fontWeight={800} fontFamily="Georgia, 'Times New Roman', serif" letterSpacing={rank === "10" ? -10 : 0}>
              {rank}
            </text>
            <Pip suit={suit} x={150} y={250} size={130} />
          </>
        ) : (
          <>
            <Corner rank={rank} suit={suit} />
            <g transform="rotate(180 125 175)">
              <Corner rank={rank} suit={suit} />
            </g>
            {r === "A" ? <Pip suit={suit} x={C} y={MID} size={suit === "D" ? 120 : 110} /> : null}
            {PIPS[r]?.map(([x, y], i) => <Pip key={i} suit={suit} x={x} y={y} size={r === "9" || r === "T" ? 46 : 52} flip={y > MID + 1} />)}
          </>
        )}
      </g>
      {court && !simple ? (
        <g>
          <defs>
            <clipPath id={clip}>
              <rect x="52" y="48" width="146" height="127" />
            </clipPath>
          </defs>
          <rect x="50" y="46" width="150" height="258" rx="6" fill="#fdf6e3" stroke={ink} strokeWidth={3} />
          <g clipPath={`url(#${clip})`}>
            <CourtHalf rank={r} suit={suit} red={red} />
          </g>
          <g transform="rotate(180 125 175)">
            <g clipPath={`url(#${clip})`}>
              <CourtHalf rank={r} suit={suit} red={red} />
            </g>
          </g>
          <path d="M52 175 L198 175" stroke={GOLD_DARK} strokeWidth={2} />
        </g>
      ) : null}
    </svg>
  );
}

/** One card, face up. `lifted` marks a card that makes the hand; `dim` a spare card outside the best five.
 *  `card` null draws the old back (kept for callers that want a face-down card). */
export function PlayingCard({ card, size = "md", lifted = false, dim = false, className = "" }: { card: string | null; size?: CardSize; lifted?: boolean; dim?: boolean; className?: string }) {
  const w = WIDTH[size];
  const radius = size === "sm" ? "rounded-[3px]" : size === "md" ? "rounded-[5px]" : "rounded-[8%]";
  if (!card) {
    return (
      <span role="img" aria-label="Face-down card" className={`relative inline-block aspect-[5/7] shrink-0 overflow-hidden border border-white/20 bg-[linear-gradient(135deg,#3b2a6b,#1a1533)] ${w} ${radius} ${className}`}>
        <span className="absolute inset-[8%] rounded-[3px] border border-white/20 bg-[repeating-linear-gradient(45deg,rgba(167,139,250,0.35)_0_3px,transparent_3px_7px)]" />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={cardLabel(card)}
      title={cardLabel(card)}
      className={`sw-motion relative inline-block aspect-[5/7] shrink-0 select-none overflow-hidden bg-white transition-[transform,box-shadow,opacity] duration-300 ${w} ${radius} ${
        lifted ? "-translate-y-1 shadow-[0_0_0_2px_rgba(251,191,36,0.85),0_8px_18px_-4px_rgba(251,191,36,0.55)]" : "shadow-[0_4px_10px_-3px_rgba(0,0,0,0.7)]"
      } ${dim ? "opacity-60" : ""} ${className}`}
    >
      <CardFace card={card} simple={size === "sm"} />
    </span>
  );
}
