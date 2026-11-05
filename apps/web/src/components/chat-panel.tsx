"use client";

// Floor chat panel. Pass the live socket so new messages arrive without
// polling; the panel keeps unread counts per channel and a direct-message
// list. Used in the agent console (both screens) and on the floor.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { chatChannels, chatHistory, chatSend, type ChatChannelKind, type ChatChannelRef, type ChatMsg } from "@/lib/chat-actions";

const keyOf = (kind: ChatChannelKind, id: string | null) => `${kind}:${id ?? ""}`;
const directKey = (a: string, b: string) => [a, b].sort().join(":");

export function ChatPanel({ socket, meId, openDirectWith, className = "", height = "h-72" }: { socket: Socket | null; meId: string; openDirectWith?: string | null; className?: string; height?: string }) {
  const [channels, setChannels] = useState<ChatChannelRef[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string; manager: boolean }[]>([]);
  const [current, setCurrent] = useState<{ kind: ChatChannelKind; id: string | null; label: string } | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      void chatChannels().then((r) => {
        setChannels(r.channels);
        setPeople(r.people);
        setCurrent((c) => c ?? r.channels[0] ?? null);
      });
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const open = useCallback((kind: ChatChannelKind, id: string | null, label: string) => {
    setCurrent({ kind, id, label });
    setPicking(false);
    setUnread((u) => ({ ...u, [keyOf(kind, id)]: 0 }));
  }, []);

  useEffect(() => {
    if (!openDirectWith || openDirectWith === meId) return;
    const p = people.find((x) => x.id === openDirectWith);
    const t = setTimeout(() => open("DIRECT", directKey(meId, openDirectWith), p ? `@${p.name}` : "Direct message"), 0);
    return () => clearTimeout(t);
  }, [openDirectWith, meId, people, open]);

  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => void chatHistory(current.kind, current.id).then(setMessages), 0);
    return () => clearTimeout(t);
  }, [current]);

  useEffect(() => {
    if (!socket) return;
    const onMsg = (m: ChatMsg) => {
      const cur = currentRef.current;
      if (cur && cur.kind === m.channel && (cur.id ?? null) === (m.channelId ?? null)) {
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      } else if (m.senderId !== meId) {
        setUnread((u) => ({ ...u, [keyOf(m.channel, m.channelId)]: (u[keyOf(m.channel, m.channelId)] ?? 0) + 1 }));
      }
    };
    socket.on("chat:message", onMsg);
    return () => {
      socket.off("chat:message", onMsg);
    };
  }, [socket, meId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    if (!current || !draft.trim()) return;
    const body = draft;
    setDraft("");
    const r = await chatSend(current.kind, current.id, body);
    if (!r.ok) setError(r.error);
    else {
      setError(null);
      setMessages((prev) => (prev.some((x) => x.id === r.message.id) ? prev : [...prev, r.message]));
    }
  };

  const totalUnread = Object.entries(unread).reduce((n, [k, v]) => (current && k === keyOf(current.kind, current.id) ? n : n + v), 0);
  const directLabel = (id: string) => `@${people.find((p) => p.id === id)?.name ?? "someone"}`;

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="mb-2 flex items-center gap-2">
        <button onClick={() => setPicking((p) => !p)} className="flex flex-1 items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-left text-sm">
          <span className="truncate">{current?.label ?? "Chat"}</span>
          <span className="text-xs text-zinc-500">{totalUnread ? <span className="rounded-full bg-fuchsia-500 px-1.5 text-[10px] font-bold text-white">{totalUnread}</span> : "▾"}</span>
        </button>
      </div>
      {picking ? (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950 p-1 text-sm">
          {channels.map((c) => {
            const k = keyOf(c.kind, c.id);
            return (
              <button key={k} onClick={() => open(c.kind, c.id, c.label)} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-white/10">
                <span>{c.label}</span>
                {unread[k] ? <span className="rounded-full bg-fuchsia-500 px-1.5 text-[10px] font-bold text-white">{unread[k]}</span> : null}
              </button>
            );
          })}
          <div className="mt-1 border-t border-white/10 px-2 pt-1 text-[10px] uppercase tracking-wider text-zinc-500">Direct messages</div>
          {people.map((p) => {
            const id = directKey(meId, p.id);
            const k = keyOf("DIRECT", id);
            return (
              <button key={p.id} onClick={() => open("DIRECT", id, directLabel(p.id))} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-white/10">
                <span>
                  {p.name} {p.manager ? <span className="text-[10px] text-zinc-500">· manager</span> : null}
                </span>
                {unread[k] ? <span className="rounded-full bg-fuchsia-500 px-1.5 text-[10px] font-bold text-white">{unread[k]}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div ref={listRef} className={`${height} space-y-1 overflow-y-auto rounded-lg bg-black/30 p-2 text-sm`}>
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.senderId === meId ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-1.5 ${m.senderId === meId ? "bg-fuchsia-500/20 text-fuchsia-100" : "bg-white/10 text-zinc-100"}`}>
              {m.senderId !== meId ? <div className="text-[10px] font-semibold text-zinc-400">{m.senderName}</div> : null}
              <div className="whitespace-pre-wrap break-words">{m.body}</div>
              <div className="mt-0.5 text-[10px] text-zinc-500">{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
            </div>
          </div>
        ))}
        {messages.length === 0 ? <div className="text-xs text-zinc-500">Nothing here yet.</div> : null}
      </div>
      {error ? <div className="mt-1 text-xs text-red-300">{error}</div> : null}
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={current ? `Message ${current.label}…` : "Pick a channel"}
          className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm placeholder:text-zinc-600"
        />
        <button onClick={() => void send()} disabled={!draft.trim() || !current} className="rounded-lg bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/15 disabled:opacity-40">
          Send
        </button>
      </div>
    </div>
  );
}
