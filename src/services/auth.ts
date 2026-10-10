import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sessions, users, workers, type Worker } from "../db/schema";
import { SESSION_MAX_AGE_SECONDS } from "../config";

export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function findSession(sessionId: string) {
  return db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
}

export function getUserFromSession(sessionId: string) {
  const session = findSession(sessionId);

  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return null;
  }

  const user = db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();

  return user ?? null;
}

export type AuthUser = NonNullable<ReturnType<typeof getUserFromSession>>;

export function requireUser(cookie: { session?: { value?: string } }) {
  const sessionId = cookie.session?.value as string | undefined;
  if (!sessionId) return null;
  return getUserFromSession(sessionId);
}

export function getWorkerFromRequest(request: Request): Worker | null {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+clw_([A-Za-z0-9-]+)_([0-9a-f]+)$/i);
  if (!match) return null;

  const worker = db
    .select()
    .from(workers)
    .where(eq(workers.id, match[1]))
    .get();

  if (!worker) return null;

  const hash = sha256hex(`clw_${match[1]}_${match[2]}`);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(worker.apiKeyHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return worker;
}

export function requireWorker(request: Request): Worker | null {
  const worker = getWorkerFromRequest(request);
  if (!worker) return null;

  db.update(workers)
    .set({ lastHeartbeat: new Date().toISOString() })
    .where(eq(workers.id, worker.id))
    .run();

  return worker;
}

export function getSessionCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
    secure: isProduction,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
