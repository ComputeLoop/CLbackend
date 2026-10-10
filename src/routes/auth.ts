import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import { getSessionCookieOptions, requireUser } from "../services/auth";

export const authRoutes = new Elysia({ prefix: "/auth" })
  .post(
    "/register",
    async ({ body, status }) => {
      const existingEmail = db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.email))
        .get();

      if (existingEmail) {
        return status(409, { message: "Email already registered" });
      }

      const existingUsername = db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username))
        .get();

      if (existingUsername) {
        return status(409, { message: "Username already taken" });
      }

      const passwordHash = await Bun.password.hash(body.password, {
        algorithm: "bcrypt",
      });

      const userId = crypto.randomUUID();

      try {
        db.insert(users)
          .values({
            id: userId,
            email: body.email,
            username: body.username,
            passwordHash,
            createdAt: new Date().toISOString(),
          })
          .run();
      } catch (error) {
        console.error("Register insert failed:", error);
        return status(409, { message: "Email or username already registered" });
      }

      return {
        message: "Registration successful",
        user: { id: userId, email: body.email, username: body.username },
      };
    },
    {
      body: t.Object({
        email: t.String(),
        username: t.String(),
        password: t.String({ minLength: 8 }),
      }),
    },
  )
  .post(
    "/login",
    async ({ body, status, cookie }) => {
      const user = db
        .select()
        .from(users)
        .where(eq(users.email, body.email))
        .get();

      if (!user) {
        return status(401, { message: "Invalid email or password" });
      }

      const passwordValid = await Bun.password.verify(
        body.password,
        user.passwordHash,
      );

      if (!passwordValid) {
        return status(401, { message: "Invalid email or password" });
      }

      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      db.insert(sessions)
        .values({ id: sessionId, userId: user.id, expiresAt })
        .run();

      cookie.session.set({
        value: sessionId,
        ...getSessionCookieOptions(),
      });

      return {
        message: "Login successful",
        user: { id: user.id, email: user.email, username: user.username },
      };
    },
    {
      body: t.Object({ email: t.String(), password: t.String() }),
    },
  )
  .get("/me", ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });
    return { user };
  })
  .post("/logout", ({ cookie }) => {
    const sessionId = cookie.session?.value as string | undefined;
    if (sessionId) {
      db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }
    cookie.session.remove();
    return { message: "Logout successful" };
  });
