// The Strowger story, told as a six-panel strip. Almon Brown Strowger, Kansas
// City undertaker, 1889: convinced the switchboard operator (the wife of a
// rival undertaker) was sending his calls to the competition, he built the
// automatic telephone exchange so no operator could ever do it again.
// Patented 1891; the first exchange opened in La Porte, Indiana, in 1892.
import type { ReactNode } from "react";

const ink = "#1b1b1f";
const paper = "#f6efe0";
const accent = "#c8472b";

function Panel({ n, title, children, caption }: { n: number; title: string; children: ReactNode; caption: ReactNode }) {
  return (
    <figure className="flex flex-col">
      <div className="relative rounded-sm border-[3px] bg-[#f6efe0] shadow-[6px_6px_0_#000]" style={{ borderColor: ink }}>
        <span className="absolute left-0 top-0 z-10 bg-[#1b1b1f] px-2 py-0.5 font-mono text-[11px] font-bold text-[#f6efe0]">{n}</span>
        <span className="absolute right-0 top-0 z-10 bg-[#c8472b] px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[#f6efe0]">{title}</span>
        <svg viewBox="0 0 320 220" className="block w-full" role="img" aria-label={title}>
          <defs>
            <pattern id={`dots${n}`} width="6" height="6" patternUnits="userSpaceOnUse">
              <circle cx="3" cy="3" r="1.1" fill={ink} opacity="0.18" />
            </pattern>
          </defs>
          {children}
        </svg>
      </div>
      <figcaption className="mt-3 border-l-[3px] pl-3 text-sm leading-snug text-zinc-300" style={{ borderColor: accent }}>
        {caption}
      </figcaption>
    </figure>
  );
}

/** A speech bubble with a tail toward (tx, ty). */
function Bubble({ x, y, w, h, tx, ty, lines, size = 11 }: { x: number; y: number; w: number; h: number; tx: number; ty: number; lines: string[]; size?: number }) {
  const cx = x + w / 2;
  const cy = y + h;
  return (
    <g>
      <path d={`M${cx - 10},${cy} L${tx},${ty} L${cx + 6},${cy} Z`} fill="#fff" stroke={ink} strokeWidth="2.5" strokeLinejoin="round" />
      <rect x={x} y={y} width={w} height={h} rx="10" fill="#fff" stroke={ink} strokeWidth="2.5" />
      <rect x={x + 2} y={y + 2} width={w - 4} height={h - 4} rx="8" fill="#fff" />
      {lines.map((l, i) => (
        <text key={i} x={cx} y={y + 15 + i * (size + 3)} textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontWeight="700" fontSize={size} fill={ink}>
          {l}
        </text>
      ))}
    </g>
  );
}

/** A simple figure: head, body, arms. `hat` adds an undertaker's top hat. */
function Person({ x, y, hat = false, dress = false, scale = 1, arm = "down", flip = false }: { x: number; y: number; hat?: boolean; dress?: boolean; scale?: number; arm?: "down" | "up" | "out"; flip?: boolean }) {
  const armPath = arm === "up" ? "M-14,30 L-26,6" : arm === "out" ? "M-14,30 L-40,26" : "M-14,30 L-18,58";
  return (
    <g transform={`translate(${x},${y}) scale(${flip ? -scale : scale},${scale})`} stroke={ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <circle cx="0" cy="0" r="13" fill={paper} />
      <path d="M-5,-2 l2,1 M5,-2 l-2,1" />
      <path d="M-4,6 q4,3 8,0" />
      {hat ? (
        <g fill={ink}>
          <rect x="-11" y="-32" width="22" height="20" />
          <rect x="-17" y="-14" width="34" height="4" />
        </g>
      ) : (
        <path d="M-12,-6 q12,-14 24,0" fill={ink} stroke="none" />
      )}
      {dress ? <path d="M-14,30 L-22,75 L22,75 L14,30 Z" fill={ink} /> : <path d="M-14,30 L-14,70 L14,70 L14,30 Z" fill={ink} />}
      <path d="M-14,30 L14,30 L8,16 L-8,16 Z" fill={ink} />
      <path d={armPath} />
      <path d="M14,30 L18,58" />
      {!dress ? <path d="M-8,70 L-8,92 M8,70 L8,92" /> : null}
    </g>
  );
}

export function StrowgerComic() {
  return (
    <section className="w-full max-w-6xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-[#c8472b]">Why it is called Strowger</div>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">Kansas City, 1889</h2>
        </div>
        <div className="hidden text-right text-xs text-zinc-500 sm:block">
          A true story, more or less.
          <br />
          Almon Brown Strowger, undertaker.
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Panel n={1} title="The undertaker" caption={<>Almon Strowger buries the dead of Kansas City. Lately, not many of them. The phone on the wall hardly rings.</>}>
          <rect width="320" height="220" fill={`url(#dots1)`} />
          <rect x="18" y="40" width="284" height="150" fill={paper} stroke={ink} strokeWidth="3" />
          <text x="160" y="30" textAnchor="middle" fontFamily="Georgia, serif" fontSize="16" fontWeight="700" fill={ink} letterSpacing="2">
            A. B. STROWGER · UNDERTAKER
          </text>
          {/* coffin */}
          <path d="M40,120 L70,100 L150,100 L180,120 L150,140 L70,140 Z" fill={ink} />
          <path d="M70,100 L70,140 M150,100 L150,140" stroke={paper} strokeWidth="2" />
          {/* wall phone */}
          <rect x="236" y="70" width="34" height="60" rx="3" fill="#7a5230" stroke={ink} strokeWidth="2.5" />
          <circle cx="253" cy="82" r="5" fill={ink} />
          <circle cx="245" cy="98" r="3.5" fill={ink} />
          <circle cx="261" cy="98" r="3.5" fill={ink} />
          <path d="M253,108 l0,18" stroke={ink} strokeWidth="3" />
          <path d="M243,126 h20" stroke={ink} strokeWidth="3" />
          <Person x={210} y={95} hat arm="out" />
          <Bubble x={120} y={46} w={110} h={34} tx={205} ty={88} lines={["Not one call", "all week."]} />
          <path d="M276,62 q6,-8 0,-16 M284,66 q8,-10 2,-22" stroke={ink} strokeWidth="2" fill="none" opacity="0.5" />
        </Panel>

        <Panel n={2} title="The switchboard" caption={<>Every call in town goes through one operator. She is married to the other undertaker. &ldquo;Strowger&rsquo;s? One moment&hellip;&rdquo;</>}>
          <rect width="320" height="220" fill={`url(#dots2)`} />
          <rect x="30" y="60" width="150" height="130" fill="#3a3a44" stroke={ink} strokeWidth="3" />
          {Array.from({ length: 5 }).map((_, r) =>
            Array.from({ length: 6 }).map((_, c) => <circle key={`${r}${c}`} cx={48 + c * 23} cy={78 + r * 22} r="4" fill={ink} stroke={paper} strokeWidth="1.5" />),
          )}
          {/* cords: one plugged into the rival's jack */}
          <path d="M48,78 C70,150 110,150 140,160" stroke="#c8472b" strokeWidth="4" fill="none" />
          <path d="M94,100 C100,160 130,170 163,166" stroke="#c8472b" strokeWidth="4" fill="none" />
          <text x="150" y="203" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="700" fill={accent}>
            → SMITH &amp; SON, UNDERTAKERS
          </text>
          <Person x={240} y={110} dress arm="out" flip />
          <path d="M230,96 q-10,0 -10,12" stroke={ink} strokeWidth="3" fill="none" />
          <Bubble x={176} y={28} w={130} h={48} tx={240} ty={96} lines={["Strowger's?", "One moment,", "connecting you…"]} size={10} />
        </Panel>

        <Panel n={3} title="The last straw" caption={<>A friend dies. The family calls for Strowger. Strowger reads about the funeral in the paper. Smith &amp; Son handled it beautifully.</>}>
          <rect width="320" height="220" fill={`url(#dots3)`} />
          <g transform="rotate(-6 150 120)">
            <rect x="60" y="50" width="200" height="140" fill="#fff" stroke={ink} strokeWidth="3" />
            <text x="160" y="76" textAnchor="middle" fontFamily="Georgia, serif" fontSize="15" fontWeight="700" fill={ink}>
              KANSAS CITY TIMES
            </text>
            <path d="M72,84 h176" stroke={ink} strokeWidth="2" />
            <text x="80" y="104" fontFamily="Georgia, serif" fontSize="11" fontWeight="700" fill={ink}>
              FUNERAL OF MR. HOLLIS
            </text>
            <text x="80" y="118" fontFamily="Georgia, serif" fontSize="9" fill={ink}>
              arrangements by SMITH &amp; SON
            </text>
            {[134, 144, 154, 164, 174].map((y) => (
              <path key={y} d={`M80,${y} h${y % 20 === 14 ? 120 : 160}`} stroke={ink} strokeWidth="2" opacity="0.35" />
            ))}
          </g>
          <Person x={290} y={120} hat arm="up" scale={0.9} />
          <text x="262" y="52" textAnchor="middle" fontFamily="Impact, 'Arial Black', sans-serif" fontSize="26" fill={accent} stroke={ink} strokeWidth="1">
            !!
          </text>
          <path d="M268,70 l-8,-10 M276,62 l-3,-14 M258,80 l-14,-4" stroke={accent} strokeWidth="3" strokeLinecap="round" />
        </Panel>

        <Panel n={4} title="The collar box" caption={<>At his kitchen table, with a round collar box, a pencil and a handful of hat pins, he works out a switch that needs no operator at all.</>}>
          <rect width="320" height="220" fill={`url(#dots4)`} />
          <path d="M20,170 h280" stroke={ink} strokeWidth="4" />
          <path d="M40,170 l-6,40 M280,170 l6,40" stroke={ink} strokeWidth="4" />
          {/* collar box with pins */}
          <ellipse cx="150" cy="150" rx="70" ry="18" fill="#d9c7a0" stroke={ink} strokeWidth="3" />
          <path d="M80,150 v-40 a70,18 0 0 1 140,0 v40" fill="#e8d9b5" stroke={ink} strokeWidth="3" />
          <ellipse cx="150" cy="110" rx="70" ry="18" fill="#efe3c5" stroke={ink} strokeWidth="3" />
          {Array.from({ length: 10 }).map((_, i) => {
            const a = (i / 10) * Math.PI * 2;
            const x = 150 + Math.cos(a) * 52;
            const y = 110 + Math.sin(a) * 12;
            return <path key={i} d={`M${x},${y} L${x},${y - 26}`} stroke={ink} strokeWidth="2" />;
          })}
          <circle cx="150" cy="110" r="4" fill={accent} />
          <path d="M150,110 L190,100" stroke={accent} strokeWidth="2.5" />
          {/* pencil */}
          <g transform="rotate(-30 60 120)">
            <rect x="30" y="116" width="60" height="8" fill="#e9b949" stroke={ink} strokeWidth="2" />
            <path d="M90,116 l10,4 l-10,4 Z" fill={paper} stroke={ink} strokeWidth="2" />
          </g>
          <Person x={262} y={80} hat arm="out" scale={0.85} flip />
          <Bubble x={14} y={14} w={160} h={48} tx={120} ty={95} lines={["If the caller does", "the connecting,", "nobody can meddle."]} size={10} />
        </Panel>

        <Panel n={5} title="La Porte, 1892" caption={<>Patent 447,918, March 1891. The first automatic exchange opens in La Porte, Indiana. Advertised as &ldquo;girl-less, cuss-less, out-of-order-less, wait-less.&rdquo;</>}>
          <rect width="320" height="220" fill={`url(#dots5)`} />
          {/* exchange cabinet with rotating selector */}
          <rect x="40" y="40" width="120" height="150" fill="#4a4e5a" stroke={ink} strokeWidth="3" />
          <circle cx="100" cy="100" r="40" fill={paper} stroke={ink} strokeWidth="3" />
          {Array.from({ length: 10 }).map((_, i) => {
            const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
            return <circle key={i} cx={100 + Math.cos(a) * 30} cy={100 + Math.sin(a) * 30} r="3.5" fill={ink} />;
          })}
          <path d="M100,100 L124,80" stroke={accent} strokeWidth="4" strokeLinecap="round" />
          <circle cx="100" cy="100" r="5" fill={accent} />
          <rect x="60" y="150" width="80" height="24" fill={ink} />
          <text x="100" y="166" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fontWeight="700" fill={paper}>
            NO OPERATOR
          </text>
          {/* poster */}
          <rect x="184" y="48" width="112" height="130" fill="#fff" stroke={ink} strokeWidth="3" />
          <text x="240" y="72" textAnchor="middle" fontFamily="Georgia, serif" fontSize="12" fontWeight="700" fill={ink}>
            THE STROWGER
          </text>
          <text x="240" y="86" textAnchor="middle" fontFamily="Georgia, serif" fontSize="10" fill={ink}>
            Automatic Telephone
          </text>
          {["GIRL-LESS", "CUSS-LESS", "OUT-OF-ORDER-LESS", "WAIT-LESS"].map((t, i) => (
            <text key={t} x="240" y={110 + i * 16} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize={t.length > 12 ? 8.5 : 10} fontWeight="700" fill={i === 3 ? accent : ink}>
              {t}
            </text>
          ))}
        </Panel>

        <Panel n={6} title="Today" caption={<><b className="text-zinc-100">They say necessity is the mother of invention. In 1889, its father was an undertaker who refused to be bypassed.</b> This dialer carries his name. No operator in the middle; your calls go where you send them.</>}>
          <rect width="320" height="220" fill={`url(#dots6)`} />
          <rect x="30" y="40" width="260" height="150" rx="6" fill="#111318" stroke={ink} strokeWidth="3" />
          <rect x="44" y="54" width="232" height="18" rx="3" fill="#1f2937" />
          <text x="54" y="67" fontFamily="ui-monospace, monospace" fontSize="10" fontWeight="700" fill="#34d399">
            READY · Waiting for Live Call
          </text>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x="44" y={82 + i * 30} width="150" height="20" rx="3" fill="#1f2937" />
              <rect x="50" y={88 + i * 30} width={60 + i * 25} height="8" rx="2" fill="#3b82f6" opacity="0.8" />
            </g>
          ))}
          <rect x="204" y="82" width="72" height="80" rx="3" fill="#1f2937" />
          <circle cx="240" cy="110" r="16" fill="#34d399" />
          <path d="M232,110 l6,6 l10,-12" stroke="#111318" strokeWidth="3.5" fill="none" strokeLinecap="round" />
          <text x="240" y="150" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="8.5" fontWeight="700" fill="#e5e7eb">
            CONNECTED
          </text>
          {/* headset agent silhouette */}
          <Person x={290} y={186} scale={0.6} />
          <path d="M281,176 q9,-14 18,0" stroke={accent} strokeWidth="3" fill="none" />
          <text x="160" y="208" textAnchor="middle" fontFamily="Georgia, serif" fontSize="11" fontStyle="italic" fill={ink}>
            Strowger, est. 1889 (he refused to be bypassed)
          </text>
        </Panel>
      </div>
    </section>
  );
}
