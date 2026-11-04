// Socket.IO hub. Agents and supervisors connect here; the engine pushes agent
// state, call events and the floor board. Rooms: tenant:<id>, agent:<userId>.
// Auth: a short-lived HMAC token the web app mints with ENGINE_INTERNAL_KEY.
import type { Server as HttpServer } from "node:http";
import { verifyRealtimeToken, type RealtimeAuth } from "@strowger/shared/secrets";
import { Server } from "socket.io";
import { config } from "./config";
import { log } from "./log";

let io: Server | null = null;

export function attachRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: [config.WEB_ORIGIN], credentials: true },
    path: "/rt",
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
