// Socket.IO hub. Agents and supervisors connect here; the engine pushes agent
// state, screen pops and the live board. Rooms: tenant:<id>, campaign:<id>,
// agent:<userId>. Auth is a short-lived token minted by the web app with the
// internal key (Phase 2 wires the softphone through the same socket).
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { config } from "./config";
import { log } from "./log";

export interface RealtimeAuth {
  tenantId: string;
  userId: string;
  roles: string[];
}

export function attachRealtime(server: HttpServer): Server {
  const io = new Server(server, {
    cors: { origin: [config.WEB_ORIGIN], credentials: true },
    path: "/rt",
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const parsed = token ? verifyToken(token) : null;
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

/**
 * Token format (Phase 0): base64url(JSON payload).base64url(HMAC-SHA256).
 * Minted by the web app with ENGINE_INTERNAL_KEY; 10-minute lifetime.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function mintToken(auth: RealtimeAuth, ttlSeconds = 600): string {
  const payload = Buffer.from(JSON.stringify({ ...auth, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = createHmac("sha256", config.ENGINE_INTERNAL_KEY).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): RealtimeAuth | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", config.ENGINE_INTERNAL_KEY).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as RealtimeAuth & { exp: number };
    if (data.exp < Date.now()) return null;
    return { tenantId: data.tenantId, userId: data.userId, roles: data.roles };
  } catch {
    return null;
  }
}
