// Socket.IO hub. Agents and supervisors connect here; the engine pushes agent
// state, call events and the floor board. Rooms: tenant:<id>, agent:<userId>.
// Auth: a short-lived HMAC token the web app mints with ENGINE_INTERNAL_KEY.
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { verifyRealtimeToken, type RealtimeAuth } from "@strowger/shared/secrets";
import { Server } from "socket.io";
import { config } from "./config";
import { handleAiUpgrade } from "./inbound/ai/session";
import { log } from "./log";

let io: Server | null = null;

export function attachRealtime(server: HttpServer): Server {
  // @fastify/websocket (the voicemail audio stream) claims every HTTP upgrade and routes it through
  // Fastify, where /rt has no route: in production that 404'd every socket and the console never
  // heard a state change (owner, 5 Nov: "Ready does nothing", "the two screens aren't in sync").
  // So: take its upgrade listeners off, let Socket.IO own /rt, and hand everything else back to them.
  // The AI answer's jambonz WebSocket (/ws/ai) goes to its own endpoint (inbound/ai/session.ts) and to nobody else:
  // @fastify/websocket would 404 it and the jambonz SDK's endpoint destroys any upgrade it does not route.
  type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  const prior = server.listeners("upgrade") as UpgradeListener[];
  server.removeAllListeners("upgrade");
  io = new Server(server, {
    cors: { origin: config.WEB_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean), credentials: true },
    path: "/rt",
    // Never destroy upgrades that are not ours: the voicemail stream needs them.
    destroyUpgrade: false,
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url ?? "").startsWith("/rt")) return;
    if (handleAiUpgrade(req, socket, head)) return;
    for (const l of prior) l(req, socket, head);
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const parsed = token ? verifyRealtimeToken(token, config.ENGINE_INTERNAL_KEY) : null;
    if (!parsed) return next(new Error("unauthorised"));
    socket.data.auth = parsed;
    next();
  });

  io.on("connection", (socket) => {
    const auth = socket.data.auth as RealtimeAuth;
    socket.join(`tenant:${auth.tenantId}`);
    socket.join(`agent:${auth.userId}`);
    log.debug({ userId: auth.userId }, "realtime connected");
    socket.on("disconnect", () => log.debug({ userId: auth.userId }, "realtime disconnected"));
  });

  return io;
}

export function emitToAgent(userId: string, event: string, payload: unknown): void {
  io?.to(`agent:${userId}`).emit(event, payload);
}

export function emitToTenant(tenantId: string, event: string, payload: unknown): void {
  io?.to(`tenant:${tenantId}`).emit(event, payload);
}
