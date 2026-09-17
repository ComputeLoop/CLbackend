import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { asc, desc, eq, sql, and } from "drizzle-orm";

import { db } from "./db";
import { projects, jobs, users, sessions } from "./db/schema";
const findSession = (sessionId: string) => {
  return db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
};
const getUserFromSession = (sessionId: string) => {
  const session = findSession(sessionId);

  if (!session) {
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
};
const app = new Elysia()
  .use(
    cors({
      origin: "http://localhost:5173",
    }),
  )

  .get("/", () => ({
    name: "Compute Loop",
    status: "online",
  }))

  .get("/health", () => ({
    status: "ok",
  }))
  .post(
    "/auth/register",
    async ({ body, status }) => {
      const existingUser = db
        .select({
          id: users.id,
        })
        .from(users)
        .where(eq(users.email, body.email))
        .get();

      if (existingUser) {
        return status(409, {
          message: "Email already registered",
        });
      }

      const passwordHash = await Bun.password.hash(body.password, {
        algorithm: "bcrypt",
      });

      const userId = crypto.randomUUID();

      db.insert(users)
        .values({
          id: userId,
          email: body.email,
          username: body.username,
          passwordHash,
          createdAt: new Date().toISOString(),
        })
        .run();

      return {
        message: "Registration successful",
        user: {
          id: userId,
          email: body.email,
          username: body.username,
        },
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
    "/auth/login",
    async ({ body, status, cookie }) => {
      const user = db
        .select()
        .from(users)
        .where(eq(users.email, body.email))
        .get();

      if (!user) {
        return status(401, {
          message: "Invalid email or password",
        });
      }

      const passwordValid = await Bun.password.verify(
        body.password,
        user.passwordHash,
      );

      if (!passwordValid) {
        return status(401, {
          message: "Invalid email or password",
        });
      }
      const sessionId = crypto.randomUUID();

      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      db.insert(sessions)
        .values({
          id: sessionId,
          userId: user.id,
          expiresAt,
        })
        .run();
      cookie.session.set({
        value: sessionId,
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
      });
      return {
        message: "Login successful",
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
        },
      };
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    },
  )
  .get("/auth/me", ({ cookie, status }) => {
    const sessionId = cookie.session.value as string | undefined;

    if (!sessionId) {
      return status(401, {
        message: "Not authenticated",
      });
    }

    const user = getUserFromSession(sessionId);

    if (!user) {
      return status(401, {
        message: "Invalid session",
      });
    }

    return {
      user,
    };
  })
  .get("/projects", async () => {
    return await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        totalJobs: projects.totalJobs,
        completedJobs: projects.completedJobs,
        status: projects.status,
      })
      .from(projects)
      .orderBy(desc(projects.createdAt));
  })

  .post(
    "/projects",
    ({ body, cookie, status }) => {
      const sessionId = cookie.session.value as string | undefined;

      if (!sessionId) {
        return status(401, {
          message: "Not authenticated",
        });
      }

      const user = getUserFromSession(sessionId);

      if (!user) {
        return status(401, {
          message: "Invalid session",
        });
      }

      const projectId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const rangeSize = 10_000;

      const jobValues: {
        id: string;
        projectId: string;
        jobNumber: number;
        status: string;
        inputStart: number;
        inputEnd: number;
      }[] = [];

      for (let i = 1; i <= body.totalJobs; i++) {
        const start = (i - 1) * rangeSize + 1;
        const end = i * rangeSize;

        jobValues.push({
          id: crypto.randomUUID(),
          projectId,
          jobNumber: i,
          status: "PENDING",
          inputStart: start,
          inputEnd: end,
        });
      }

      db.transaction((tx) => {
        tx.insert(projects)
          .values({
            id: projectId,
            ownerId: user.id,
            name: body.name,
            description: body.description,
            totalJobs: body.totalJobs,
            completedJobs: 0,
            status: "OPEN",
            createdAt,
          })
          .run();

        tx.insert(jobs).values(jobValues).run();
      });
      return {
        id: projectId,
        name: body.name,
        description: body.description,
        totalJobs: body.totalJobs,
        completedJobs: 0,
        status: "OPEN",
        ownerId: user.id,
      };
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.String(),
        totalJobs: t.Number({ minimum: 1 }),
      }),
    },
  )
  .get("/projects/:id/jobs", async ({ params }) => {
    return await db
      .select({
        id: jobs.id,
        projectId: jobs.projectId,
        jobNumber: jobs.jobNumber,
        status: jobs.status,
        workerId: jobs.workerId,
        inputStart: jobs.inputStart,
        inputEnd: jobs.inputEnd,
        result: jobs.result,
      })
      .from(jobs)
      .where(eq(jobs.projectId, params.id))
      .orderBy(asc(jobs.jobNumber));
  })

  .get(
    "/jobs/next",
    ({ query, status }) => {
      const workerId = query.workerId;

      const job = db
        .select({
          id: jobs.id,
          projectId: jobs.projectId,
          jobNumber: jobs.jobNumber,
          status: jobs.status,
          workerId: jobs.workerId,
          inputStart: jobs.inputStart,
          inputEnd: jobs.inputEnd,
          result: jobs.result,
        })
        .from(jobs)
        .where(
          and(eq(jobs.status, "PENDING"), eq(jobs.projectId, query.projectId)),
        )
        .orderBy(asc(jobs.jobNumber))
        .limit(1)
        .get();

      if (!job) {
        return status(404, {
          message: "No jobs available",
        });
      }

      db.update(jobs)
        .set({
          status: "RUNNING",
          workerId,
        })
        .where(eq(jobs.id, job.id))
        .run();

      return {
        id: job.id,
        projectId: job.projectId,
        jobNumber: job.jobNumber,
        status: "RUNNING",
        workerId,
        input: {
          start: job.inputStart,
          end: job.inputEnd,
        },
      };
    },
    {
      query: t.Object({
        workerId: t.String(),
        projectId : t.String()
      }),
    },
  )

  .post(
    "/jobs/:id/complete",
    ({ params, body, status }) => {
      const job = db
        .select({
          id: jobs.id,
          projectId: jobs.projectId,
          jobNumber: jobs.jobNumber,
          status: jobs.status,
          workerId: jobs.workerId,
          inputStart: jobs.inputStart,
          inputEnd: jobs.inputEnd,
          result: jobs.result,
        })
        .from(jobs)
        .where(eq(jobs.id, params.id))
        .get();

      if (!job) {
        return status(404, {
          message: "Job not found",
        });
      }

      if (job.status !== "RUNNING") {
        return status(400, {
          message: "Job is not running",
        });
      }

      // Update job and project together.
      const result = db.transaction((tx) => {
        tx.update(jobs)
          .set({
            status: "COMPLETED",
            result: body.result,
          })
          .where(eq(jobs.id, params.id))
          .run();

        tx.update(projects)
          .set({
            completedJobs: sql`${projects.completedJobs} + 1`,
          })
          .where(eq(projects.id, job.projectId))
          .run();

        const project = tx
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            totalJobs: projects.totalJobs,
            completedJobs: projects.completedJobs,
            status: projects.status,
          })
          .from(projects)
          .where(eq(projects.id, job.projectId))
          .get();

        if (!project) {
          return null;
        }

        const newStatus =
          project.completedJobs >= project.totalJobs ? "COMPLETED" : "RUNNING";

        tx.update(projects)
          .set({
            status: newStatus,
          })
          .where(eq(projects.id, job.projectId))
          .run();

        return {
          ...project,
          status: newStatus,
        };
      });

      return {
        message: "Job completed",

        job: {
          ...job,
          status: "COMPLETED",
          result: body.result,
        },

        project: result,
      };
    },
    {
      body: t.Object({
        result: t.String(),
      }),
    },
  )

  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);
