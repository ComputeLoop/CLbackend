import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, and, ne, lt, sql, isNull, isNotNull, count, inArray } from "drizzle-orm";

import { db } from "./db";
import {
  projects,
  jobs,
  users,
  sessions,
  datasets,
  workers,
} from "./db/schema";
import {
  signUrl,
  verifySignature,
  writeObject,
  readObject,
  objectFile,
  objectFilePath,
  contentTypeFor,
} from "./storage";
import { getOperation, OPERATIONS, toPublicOperation } from "./operations";
import {
  detectFormat,
  extractFileList,
  scanTabular,
  planChunks,
} from "./dataset";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CLAIM_TTL_MS = Number(process.env.WORKER_LEASE_MS ?? 15 * 60 * 1000);
const MAX_FAIL_ATTEMPTS = Number(process.env.MAX_FAIL_ATTEMPTS ?? 3);

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
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

  // Expired sessions are invalid and cleaned up.
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
};

type User = NonNullable<ReturnType<typeof getUserFromSession>>;

const requireUser = (cookie: { session?: { value?: string } }) => {
  const sessionId = cookie.session?.value as string | undefined;
  if (!sessionId) return null;
  return getUserFromSession(sessionId);
};

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Parse `Authorization: Bearer clw_<workerId>_<secret>` and validate it. */
const getWorkerFromRequest = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(
    /^Bearer\s+clw_([A-Za-z0-9-]+)_([0-9a-f]+)$/i,
  );
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
};

const requireWorker = (request: Request) => {
  const worker = getWorkerFromRequest(request);
  if (!worker) return null;
  // Touching the API counts as liveness for busy loops.
  db.update(workers)
    .set({ lastHeartbeat: new Date().toISOString() })
    .where(eq(workers.id, worker.id))
    .run();
  return worker;
};

// ---------------------------------------------------------------------------
// Project helpers
// ---------------------------------------------------------------------------
const projectFields = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  totalJobs: projects.totalJobs,
  completedJobs: projects.completedJobs,
  status: projects.status,
  ownerId: projects.ownerId,
  opType: projects.opType,
  splitType: projects.splitType,
  datasetId: projects.datasetId,
  mergedKey: projects.mergedKey,
  mergedAt: projects.mergedAt,
};

const getProject = (id: string) =>
  db.select(projectFields).from(projects).where(eq(projects.id, id)).get();

const getDataset = (id: string) =>
  db.select().from(datasets).where(eq(datasets.id, id)).get();

function sanitizeFilename(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return cleaned || "file";
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] === "" ? NaN : Number(match[1]);
  let end = match[2] === "" ? NaN : Number(match[2]);
  if (Number.isNaN(start)) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (Number.isNaN(end)) end = size - 1;
  }
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

// ---------------------------------------------------------------------------
// Chunk / job helpers
// ---------------------------------------------------------------------------
const jobFields = {
  id: jobs.id,
  projectId: jobs.projectId,
  jobNumber: jobs.jobNumber,
  status: jobs.status,
  workerId: jobs.workerId,
  inputStart: jobs.inputStart,
  inputEnd: jobs.inputEnd,
  result: jobs.result,
  inputKey: jobs.inputKey,
  inputManifest: jobs.inputManifest,
  outputKey: jobs.outputKey,
  outputHash: jobs.outputHash,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
  durationMs: jobs.durationMs,
  gpuName: jobs.gpuName,
  attempts: jobs.attempts,
  error: jobs.error,
};

/** Requeue chunks that have been RUNNING longer than the lease timeout. */
function sweepStaleJobs() {
  const cutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
  db.update(jobs)
    .set({ status: "PENDING", workerId: null })
    .where(
      and(
        eq(jobs.status, "RUNNING"),
        isNotNull(jobs.startedAt),
        lt(jobs.startedAt, cutoff),
      ),
    )
    .run();
}

/** Atomically claim the next PENDING chunk for this project (busy retry). */
function claimJob(workerId: string, projectId: string, outputKey: string) {
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = db
      .select(jobFields)
      .from(jobs)
      .where(and(eq(jobs.status, "PENDING"), eq(jobs.projectId, projectId)))
      .orderBy(asc(jobs.jobNumber))
      .limit(1)
      .get();

    if (!candidate) return null;

    const result = db
      .update(jobs)
      .set({
        status: "RUNNING",
        workerId,
        startedAt: now,
        outputKey,
      })
      .where(
        and(eq(jobs.id, candidate.id), eq(jobs.status, "PENDING")),
      )
      .run();

    if (result.changes > 0) {
      return {
        ...candidate,
        status: "RUNNING",
        workerId,
        startedAt: now,
        outputKey,
      };
    }
  }
  return null;
}

const JSONL_OPS = new Set(["image-hash", "image-classify"]);

/**
 * Merge all completed chunk outputs into one artifact.
 * Guarded by `mergedAt` so concurrent completions can't double-merge.
 */
async function mergeProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) return { merged: false, reason: "project not found" };

  const chunks = db
    .select(jobFields)
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .orderBy(asc(jobs.jobNumber))
    .all();

  if (chunks.some((c) => c.status !== "COMPLETED")) {
    return { merged: false, reason: "not all chunks completed" };
  }

  const op = getOperation(project.opType);
  const outputs: Buffer[] = [];
  for (const chunk of chunks) {
    if (!chunk.outputKey) {
      return { merged: false, reason: `chunk ${chunk.jobNumber} has no output key` };
    }
    const data = await readObject(chunk.outputKey);
    if (!data) {
      return { merged: false, reason: `chunk ${chunk.jobNumber} output missing from storage` };
    }
    outputs.push(data);
  }

  const mergedKey = `projects/${projectId}/merged/results${
    op && JSONL_OPS.has(op.type) ? ".jsonl" : ".json"
  }`;

  let merged: Uint8Array;
  if (op && JSONL_OPS.has(op.type)) {
    // Concatenate JSONL records; keep a single trailing newline.
    const cleaned = outputs.map((b) => {
      let s = b.toString("utf8").trim();
      return s.length ? `${s}\n` : "";
    });
    merged = new TextEncoder().encode(cleaned.join(""));
  } else {
    const parsed = outputs.map((b) => {
      try {
        return JSON.parse(b.toString("utf8"));
      } catch {
        return b.toString("utf8");
      }
    });
    merged = new TextEncoder().encode(JSON.stringify(parsed, null, 2) + "\n");
  }

  await writeObject(mergedKey, merged);

  const claimed = db
    .update(projects)
    .set({
      status: "COMPLETED",
      mergedKey,
      mergedAt: new Date().toISOString(),
    })
    .where(and(eq(projects.id, projectId), isNull(projects.mergedAt)))
    .run();

  if (claimed.changes === 0) {
    return { merged: false, reason: "already merged" };
  }

  const projectAfter = getProject(projectId);
  return { merged: true, mergedKey, project: projectAfter };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = new Elysia()
  .use(
    cors({
      origin: [
        "http://localhost:5173",
        "https://clfrontend-eight.vercel.app",
      ],
      credentials: true,
    }),
  )
  // Ensure every error response is JSON (a thrown SQLite/other error must
  // never leak as raw text that a client tries to JSON.parse).
  .onError(({ code, error, set, path }) => {
    if (code === "VALIDATION") {
      set.status = 400;
      return { message: error.message };
    }
    console.error(`[${new Date().toISOString()}] ${path} ->`, error);
    set.status = 500;
    return { message: "Internal server error" };
  })

  .get("/", () => ({
    name: "Compute Loop",
    status: "online",
  }))

  .get("/health", () => ({
    status: "ok",
  }))

  .get("/operations", () => OPERATIONS.map(toPublicOperation))

  // ---------------------------------------------------------------- auth
  .post(
    "/auth/register",
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
        // Defense in depth: UNIQUE races on email/username must be a JSON 409.
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
    "/auth/login",
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
        httpOnly: true,
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 7 * 24 * 60 * 60,
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
  .get("/auth/me", ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });
    return { user };
  })
  .post("/auth/logout", ({ cookie, status }) => {
    const sessionId = cookie.session?.value as string | undefined;
    if (sessionId) {
      db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }
    cookie.session.remove();
    return { message: "Logout successful" };
  })

  // ------------------------------------------------------------ projects
  .get("/projects", async ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const rows = await db
      .select(projectFields)
      .from(projects)
      .where(eq(projects.ownerId, user.id))
      .orderBy(desc(projects.createdAt));

    const datasetIds = [
      ...new Set(rows.map((r) => r.datasetId).filter(Boolean)),
    ] as string[];

    const datasetRows =
      datasetIds.length > 0
        ? await db
            .select({
              id: datasets.id,
              projectId: datasets.projectId,
              format: datasets.format,
              itemCount: datasets.itemCount,
              originalName: datasets.originalName,
            })
            .from(datasets)
            .where(sql`${datasets.id} IN (${sql.join(datasetIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];

    const datasetByProject = new Map(
      datasetRows.map((d) => [d.projectId, d]),
    );

    return rows.map((project) => {
      const op = getOperation(project.opType);
      const dataset = datasetByProject.get(project.id);
      return {
        ...project,
        opName: op?.name ?? project.opType,
        gpu: op?.gpu ?? false,
        hasDataset: project.datasetId != null,
        itemCount: dataset?.itemCount ?? null,
        datasetFormat: dataset?.format ?? null,
        isSplit: project.totalJobs > 0,
        hasResult: project.mergedAt != null,
      };
    });
  })

  // ------------------------------------------------------------- explore
  // Public "for you" feed: every renter's project that still has unfinished
  // chunks, so contributors can browse and pick one. Safe metadata only —
  // no chunk manifests, storage keys, dataset contents, or results. A
  // contributor gets access to a chunk's input only by claiming it, and can
  // never list anyone's chunks (the jobs endpoint stays owner-scoped).
  .get("/explore", async ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        totalJobs: projects.totalJobs,
        completedJobs: projects.completedJobs,
        status: projects.status,
        ownerId: projects.ownerId,
        opType: projects.opType,
        datasetId: projects.datasetId,
        createdAt: projects.createdAt,
        ownerUsername: users.username,
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.ownerId))
      .where(
        and(
          sql`${projects.totalJobs} > 0`,
          sql`${projects.completedJobs} < ${projects.totalJobs}`,
        ),
      )
      .orderBy(desc(projects.createdAt));

    const datasetIds = [
      ...new Set(rows.map((r) => r.datasetId).filter(Boolean)),
    ] as string[];

    const datasetRows =
      datasetIds.length > 0
        ? await db
            .select({
              id: datasets.id,
              projectId: datasets.projectId,
              format: datasets.format,
              itemCount: datasets.itemCount,
              originalName: datasets.originalName,
              sizeBytes: datasets.sizeBytes,
            })
            .from(datasets)
            .where(
              sql`${datasets.id} IN (${sql.join(datasetIds.map((id) => sql`${id}`), sql`, `)})`,
            )
        : [];

    const datasetByProject = new Map(datasetRows.map((d) => [d.projectId, d]));

    const projectIds = rows.map((r) => r.id);
    const jobStats =
      projectIds.length > 0
        ? await db
            .select({
              projectId: jobs.projectId,
              chunks: sql<number>`COUNT(*)`,
              contributors: sql<number>`COUNT(DISTINCT ${jobs.workerId})`,
            })
            .from(jobs)
            .where(inArray(jobs.projectId, projectIds))
            .groupBy(jobs.projectId)
        : [];
    const statsByProject = new Map(jobStats.map((s) => [s.projectId, s]));

    return rows.map((project) => {
      const op = getOperation(project.opType);
      const dataset = datasetByProject.get(project.id);
      const stats = statsByProject.get(project.id);
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        opType: project.opType,
        opName: op?.name ?? project.opType,
        gpu: op?.gpu ?? false,
        status: project.status,
        ownerId: project.ownerId,
        ownerUsername: project.ownerUsername,
        dataset: dataset
          ? {
              format: dataset.format,
              itemCount: dataset.itemCount,
              originalName: dataset.originalName,
              sizeBytes: dataset.sizeBytes,
            }
          : null,
        totalJobs: project.totalJobs,
        completedJobs: project.completedJobs,
        pendingJobs: project.totalJobs - project.completedJobs,
        contributors: stats?.contributors ?? 0,
        createdAt: project.createdAt,
      };
    });
  })

  .post(
    "/projects",
    ({ body, cookie, status }) => {
      const user = requireUser(cookie);
      if (!user) return status(401, { message: "Not authenticated" });

      const op = getOperation(body.opType);
      if (!op) {
        return status(400, { message: `Unknown operation "${body.opType}"` });
      }

      const projectId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      db.insert(projects)
        .values({
          id: projectId,
          ownerId: user.id,
          name: body.name,
          description: body.description,
          opType: op.type,
          totalJobs: 0,
          completedJobs: 0,
          status: "OPEN",
          createdAt,
        })
        .run();

      return {
        id: projectId,
        name: body.name,
        description: body.description,
        opType: op.type,
        opName: op.name,
        gpu: op.gpu,
        totalJobs: 0,
        completedJobs: 0,
        status: "OPEN",
        ownerId: user.id,
        hasDataset: false,
        isSplit: false,
        hasResult: false,
      };
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.String(),
        opType: t.String(),
      }),
    },
  )

  .get("/projects/:id", ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "You don't have access to this project" });
    }

    const dataset = project.datasetId ? getDataset(project.datasetId) : null;
    const op = getOperation(project.opType);

    return {
      ...project,
      opName: op?.name ?? project.opType,
      gpu: op?.gpu ?? false,
      dataset: dataset
        ? {
            id: dataset.id,
            originalName: dataset.originalName,
            format: dataset.format,
            itemCount: dataset.itemCount,
            sizeBytes: dataset.sizeBytes,
            status: dataset.status,
          }
        : null,
      isSplit: project.totalJobs > 0,
      hasResult: project.mergedAt != null,
    };
  })

  .get("/projects/:id/jobs", async ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "You don't have access to this project" });
    }

    const rows = await db
      .select(jobFields)
      .from(jobs)
      .where(eq(jobs.projectId, params.id))
      .orderBy(asc(jobs.jobNumber));

    return rows.map((job) => {
      let manifest: unknown = null;
      let itemCount: number | null = null;
      if (job.inputManifest) {
        try {
          manifest = JSON.parse(job.inputManifest);
          if (manifest && typeof manifest === "object" && "items" in manifest) {
            itemCount = (manifest as { items: unknown[] }).items.length;
          }
        } catch {
          manifest = null;
        }
      }
      return { ...job, manifest, itemCount };
    });
  })

  // ------------------------------------------------------------ dataset
  .post(
    "/projects/:id/dataset",
    async ({ params, body, cookie, status }) => {
      const user = requireUser(cookie);
      if (!user) return status(401, { message: "Not authenticated" });

      const project = getProject(params.id);
      if (!project) return status(404, { message: "Project not found" });
      if (project.ownerId !== user.id) {
        return status(403, { message: "Only the project owner can upload data" });
      }
      if (project.datasetId) {
        return status(400, { message: "Project already has a dataset" });
      }

      const file = body.file;
      let format: "file-list" | "tabular";
      try {
        format = detectFormat(file.name);
      } catch (error) {
        return status(400, {
          message: error instanceof Error ? error.message : "Unsupported file",
        });
      }

      const datasetId = crypto.randomUUID();
      const rawKey = `datasets/${datasetId}/raw/${sanitizeFilename(file.name)}`;
      const buffer = Buffer.from(await file.arrayBuffer());

      await writeObject(rawKey, buffer);

      db.transaction((tx) => {
        tx.insert(datasets)
          .values({
            id: datasetId,
            projectId: project.id,
            name: sanitizeFilename(file.name),
            originalName: file.name,
            storageKey: rawKey,
            format,
            sizeBytes: buffer.byteLength,
            status: "UPLOADED",
            createdAt: new Date().toISOString(),
          })
          .run();

        tx.update(projects)
          .set({ datasetId })
          .where(eq(projects.id, project.id))
          .run();
      });

      return {
        id: datasetId,
        projectId: project.id,
        name: sanitizeFilename(file.name),
        format,
        sizeBytes: buffer.byteLength,
      };
    },
    {
      body: t.Object({ file: t.File() }),
    },
  )

  .post(
    "/projects/:id/split",
    async ({ params, body, cookie, status }) => {
      const user = requireUser(cookie);
      if (!user) return status(401, { message: "Not authenticated" });

      const project = getProject(params.id);
      if (!project) return status(404, { message: "Project not found" });
      if (project.ownerId !== user.id) {
        return status(403, { message: "Only the project owner can split" });
      }
      if (!project.datasetId) {
        return status(400, { message: "Upload a dataset before splitting" });
      }

      const dataset = getDataset(project.datasetId);
      if (!dataset) return status(404, { message: "Dataset not found" });

      const op = getOperation(project.opType);
      if (!op) return status(400, { message: "Unknown operation" });

      // Only the field matching the op's split kind counts. Clients that send
      // a mismatched field (or none, e.g. a fresh project whose split_type is
      // still NULL) must not silently fall back to an unexpected size.
      const chunkSize =
        op.splitKind === "file-list"
          ? body.itemsPerChunk ?? op.defaultChunkSize
          : body.rowsPerChunk ?? op.defaultChunkSize;

      let extra: { files?: Awaited<ReturnType<typeof extractFileList>>["files"]; scan?: Awaited<ReturnType<typeof scanTabular>> };

      db.update(datasets)
        .set({ status: "PROCESSING" })
        .where(eq(datasets.id, dataset.id))
        .run();

      try {
        if (op.splitKind === "file-list") {
          const { files } = await extractFileList(dataset.id, dataset.storageKey);
          extra = { files };
          db.update(datasets)
            .set({ itemCount: files.length, status: "READY" })
            .where(eq(datasets.id, dataset.id))
            .run();
        } else {
          const scan = await scanTabular(dataset.storageKey);
          extra = { scan };
          db.update(datasets)
            .set({ itemCount: Math.max(0, scan.lineCount - 1), status: "READY" })
            .where(eq(datasets.id, dataset.id))
            .run();
        }
      } catch (error) {
        db.update(datasets)
          .set({ status: "ERROR" })
          .where(eq(datasets.id, dataset.id))
          .run();
        return status(500, {
          message: error instanceof Error ? error.message : "Split failed",
        });
      }

      const plans = planChunks(dataset, op, chunkSize, extra!);

      const itemCount =
        op.splitKind === "file-list"
          ? extra!.files!.length
          : Math.max(0, extra!.scan!.lineCount - 1);

      const chunkRows = plans.map((plan, index) => ({
        id: crypto.randomUUID(),
        projectId: project.id,
        jobNumber: index + 1,
        status: "PENDING",
        workerId: null,
        inputStart: plan.inputStart,
        inputEnd: plan.inputEnd,
        inputKey: plan.inputKey,
        inputManifest: JSON.stringify(plan.manifest),
        attempts: 0,
      }));

      let created = 0;
      try {
        db.transaction((tx) => {
          // Re-split is allowed only before anything has been claimed or
          // completed — otherwise completed work would be thrown away.
          const claimed = tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              and(
                eq(jobs.projectId, project.id),
                ne(jobs.status, "PENDING"),
              ),
            )
            .get();
          if (claimed) {
            throw new Error(
              "Chunks are already claimed or complete; re-split is only possible before any chunk is picked up",
            );
          }
          tx.delete(jobs).where(eq(jobs.projectId, project.id)).run();
          tx.insert(jobs).values(chunkRows).run();
          tx.update(projects)
            .set({
              totalJobs: chunkRows.length,
              completedJobs: 0,
              splitType: op.splitKind,
              status: "OPEN",
            })
            .where(eq(projects.id, project.id))
            .run();
          created = chunkRows.length;
        });
      } catch (error) {
        return status(409, {
          message:
            error instanceof Error ? error.message : "Split already done",
        });
      }

      return {
        projectId: project.id,
        chunks: created,
        itemCount,
        splitType: op.splitKind,
        opType: op.type,
      };
    },
    {
      body: t.Object({
        itemsPerChunk: t.Optional(t.Number({ minimum: 1 })),
        rowsPerChunk: t.Optional(t.Number({ minimum: 1 })),
      }),
    },
  )

  // -------------------------------------------------------------- chunks
  .get("/chunks/next", ({ query, request, status }) => {
    const worker = requireWorker(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    const project = getProject(query.projectId);
    if (!project) return status(404, { message: "Project not found" });

    sweepStaleJobs();

    const op = getOperation(project.opType);
    const isJsonl = op != null && JSONL_OPS.has(op.type);
    const outputKey = `projects/${project.id}/outputs/${crypto.randomUUID()}.${isJsonl ? "jsonl" : "json"}`;

    const job = claimJob(worker.id, project.id, outputKey);
    if (!job) {
      return status(404, { message: "No chunks available" });
    }

    db.update(workers)
      .set({ status: "WORKING" })
      .where(eq(workers.id, worker.id))
      .run();

    let manifest: unknown = null;
    try {
      manifest = job.inputManifest ? JSON.parse(job.inputManifest) : null;
    } catch {
      manifest = null;
    }

    let input;
    if (manifest && manifest.kind === "tabular") {
      const m = manifest as {
        key: string;
        byteStart: number;
        byteEnd: number;
        rowStart: number;
        rowEnd: number;
        header: string;
      };
      input = {
        kind: "tabular",
        url: signUrl("GET", m.key),
        range: { start: m.byteStart, end: m.byteEnd - 1 },
        rowStart: m.rowStart,
        rowEnd: m.rowEnd,
        header: m.header,
        bytes: m.byteEnd - m.byteStart,
      };
    } else if (manifest && manifest.kind === "file-list") {
      const items = (manifest as { items: { path: string; size: number; key: string }[] }).items;
      input = {
        kind: "file-list",
        items: items.map((item) => ({
          path: item.path,
          size: item.size,
          url: signUrl("GET", item.key),
        })),
      };
    } else {
      return status(500, { message: "Malformed chunk manifest" });
    }

    return {
      id: job.id,
      projectId: job.projectId,
      jobNumber: job.jobNumber,
      status: "RUNNING",
      workerId: worker.id,
      opType: op?.type ?? "unknown",
      opName: op?.name ?? "Unknown",
      gpu: op?.gpu ?? false,
      instructions: op?.instructions ?? null,
      attempts: job.attempts,
      input,
      output: { key: outputKey, url: signUrl("PUT", outputKey) },
    };
  })

  .post(
    "/chunks/:id/complete",
    async ({ params, body, request, status }) => {
      const worker = requireWorker(request);
      if (!worker) return status(401, { message: "Invalid worker API key" });

      const job = db
        .select(jobFields)
        .from(jobs)
        .where(eq(jobs.id, params.id))
        .get();
      if (!job) return status(404, { message: "Chunk not found" });
      if (job.workerId !== worker.id) {
        return status(403, { message: "Chunk claimed by another worker" });
      }
      if (job.status !== "RUNNING") {
        return status(400, { message: "Chunk is not running" });
      }
      if (!/^[0-9a-f]{64}$/i.test(body.outputHash)) {
        return status(400, { message: "outputHash must be a sha256 hex digest" });
      }

      const completedAt = new Date().toISOString();

      const project = db.transaction((tx) => {
        tx.update(jobs)
          .set({
            status: "COMPLETED",
            result: body.result ?? null,
            outputHash: body.outputHash,
            completedAt,
            durationMs: body.durationMs ?? null,
            gpuName: body.gpuName ?? worker.gpuName ?? null,
          })
          .where(eq(jobs.id, job.id))
          .run();

        tx.update(projects)
          .set({ completedJobs: sql`${projects.completedJobs} + 1` })
          .where(eq(projects.id, job.projectId))
          .run();

        const project = tx
          .select(projectFields)
          .from(projects)
          .where(eq(projects.id, job.projectId))
          .get();

        if (!project) return null;

        const newStatus =
          project.completedJobs >= project.totalJobs ? "COMPLETED" : "RUNNING";
        tx.update(projects)
          .set({ status: newStatus })
          .where(eq(projects.id, job.projectId))
          .run();

        return { ...project, status: newStatus };
      });

      db.update(workers)
        .set({ status: "IDLE", lastHeartbeat: completedAt })
        .where(eq(workers.id, worker.id))
        .run();

      let merge = null;
      if (project && project.status === "COMPLETED") {
        merge = await mergeProject(job.projectId);
      }

      return {
        message: "Chunk completed",
        job: { ...job, status: "COMPLETED", outputHash: body.outputHash },
        project,
        merge,
      };
    },
    {
      body: t.Object({
        outputHash: t.String(),
        result: t.Optional(t.String()),
        durationMs: t.Optional(t.Number()),
        gpuName: t.Optional(t.String()),
      }),
    },
  )

  .post(
    "/chunks/:id/fail",
    ({ params, body, request, status }) => {
      const worker = requireWorker(request);
      if (!worker) return status(401, { message: "Invalid worker API key" });

      const job = db
        .select(jobFields)
        .from(jobs)
        .where(eq(jobs.id, params.id))
        .get();
      if (!job) return status(404, { message: "Chunk not found" });
      if (job.workerId !== worker.id) {
        return status(403, { message: "Chunk claimed by another worker" });
      }
      if (job.status !== "RUNNING") {
        return status(400, { message: "Chunk is not running" });
      }

      const attempts = job.attempts + 1;
      const reason = body.reason ?? "worker reported failure";

      if (body.permanent === true) {
        // Machine/environment problem (missing dependency, bad model): record
        // it as failed right away instead of burning retries on identical
        // failures. The owner retries via POST /projects/:id/requeue after
        // fixing the machine.
        db.update(jobs)
          .set({
            status: "FAILED",
            attempts,
            error: reason,
            completedAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, job.id))
          .run();
      } else if (attempts >= MAX_FAIL_ATTEMPTS) {
        db.update(jobs)
          .set({
            status: "FAILED",
            attempts,
            error: reason,
            completedAt: new Date().toISOString(),
          })
          .where(eq(jobs.id, job.id))
          .run();
      } else {
        // Requeue so another contributor can pick it up.
        db.update(jobs)
          .set({
            status: "PENDING",
            workerId: null,
            attempts,
            error: reason,
          })
          .where(eq(jobs.id, job.id))
          .run();
      }

      db.update(workers)
        .set({ status: "IDLE", lastHeartbeat: new Date().toISOString() })
        .where(eq(workers.id, worker.id))
        .run();

      return {
        message: "Chunk failure recorded",
        attempts,
        requeued: body.permanent !== true && attempts < MAX_FAIL_ATTEMPTS,
      };
    },
    {
      body: t.Object({
        reason: t.Optional(t.String()),
        permanent: t.Optional(t.Boolean()),
      }),
    },
  )

  // ------------------------------------------------------------ requeue
  .post("/projects/:id/requeue", ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "Only the project owner can requeue" });
    }

    // Reset every FAILED chunk back to PENDING for a fresh run (e.g. after a
    // contributor fixed their machine). Attempts/errors are cleared so the
    // full retry budget applies again.
    const requeued = db.transaction((tx) => {
      const count = tx
        .update(jobs)
        .set({
          status: "PENDING",
          workerId: null,
          attempts: 0,
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          gpuName: null,
        })
        .where(and(eq(jobs.projectId, project.id), eq(jobs.status, "FAILED")))
        .run()
        .changes;

      if (count > 0) {
        tx.update(projects)
          .set({ status: "OPEN" })
          .where(eq(projects.id, project.id))
          .run();
      }
      return count;
    });

    return {
      message:
        requeued > 0
          ? `${requeued} chunk(s) moved back to PENDING`
          : "No failed chunks to requeue",
      requeued,
    };
  })

  // --------------------------------------------------------------- merge
  .post("/projects/:id/merge", async ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "Only the project owner can merge" });
    }

    return await mergeProject(project.id);
  })

  .get("/projects/:id/result", ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "Only the project owner can download results" });
    }
    if (!project.mergedKey) {
      return status(409, { message: "Project has no merged results yet" });
    }

    return { url: signUrl("GET", project.mergedKey) };
  })

  // ------------------------------------------------------------- workers
  .post(
    "/workers/register",
    ({ body, cookie, status }) => {
      const user = requireUser(cookie);
      if (!user) return status(401, { message: "Not authenticated" });

      const workerId = crypto.randomUUID();
      const secret = randomBytes(24).toString("hex");
      const apiKey = `clw_${workerId}_${secret}`;

      db.insert(workers)
        .values({
          id: workerId,
          userId: user.id,
          name: body.name,
          gpuName: body.gpuName ?? null,
          vramMb: body.vramMb ?? null,
          apiKeyHash: sha256hex(apiKey),
          status: "IDLE",
          lastHeartbeat: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        })
        .run();

      return {
        worker: { id: workerId, name: body.name, gpuName: body.gpuName },
        // Shown exactly once: the worker CLI authenticates with it.
        apiKey,
        command: `WORKER_API_KEY=${apiKey} bun run index.ts <projectId>`,
      };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        gpuName: t.Optional(t.String()),
        vramMb: t.Optional(t.Number()),
      }),
    },
  )

  .get("/workers", ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const rows = db
      .select()
      .from(workers)
      .where(eq(workers.userId, user.id))
      .orderBy(desc(workers.createdAt))
      .all();

    return rows.map((worker) => {
      const stats = db
        .select({ completed: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.workerId, worker.id),
            eq(jobs.status, "COMPLETED"),
          ),
        )
        .get();

      const online =
        worker.lastHeartbeat != null &&
        Date.now() - new Date(worker.lastHeartbeat).getTime() < 60_000;

      return {
        id: worker.id,
        name: worker.name,
        gpuName: worker.gpuName,
        vramMb: worker.vramMb,
        status: worker.status,
        lastHeartbeat: worker.lastHeartbeat,
        online,
        completedChunks: stats?.completed ?? 0,
        createdAt: worker.createdAt,
      };
    });
  })

  .get("/workers/me", ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });

    const stats = db
      .select({ completed: count() })
      .from(jobs)
      .where(and(eq(jobs.workerId, worker.id), eq(jobs.status, "COMPLETED")))
      .get();

    return { worker: { ...worker, apiKeyHash: undefined }, completedChunks: stats?.completed ?? 0 };
  })

  .post("/workers/heartbeat", ({ request, status }) => {
    const worker = getWorkerFromRequest(request);
    if (!worker) return status(401, { message: "Invalid worker API key" });
    db.update(workers)
      .set({ status: "IDLE", lastHeartbeat: new Date().toISOString() })
      .where(eq(workers.id, worker.id))
      .run();
    return { ok: true, workerId: worker.id };
  })

  // ------------------------------------------------------------ storage
  // Signed object proxy. GET serves objects (with Range support), PUT stores.
  .all("/storage/*", async ({ request, status }) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/"); // ["", "storage", op, ...rest]
      const op = parts[2]?.toUpperCase() ?? "";
      const key = decodeURIComponent(parts.slice(3).join("/"));
      const exp = url.searchParams.get("exp") ?? "";
      const sig = url.searchParams.get("sig") ?? "";

      if (op !== "GET" && op !== "PUT") {
        return status(405, { message: "Method not allowed" });
      }
      if (!verifySignature(op as "GET" | "PUT", key, exp, sig)) {
        return status(403, { message: "Invalid or expired signature" });
      }

      if (op === "GET") {
        if (!(await objectFile(key).exists())) {
          return status(404, { message: "Object not found" });
        }
        const file = objectFile(key);
        const size = file.size;
        const range = parseRange(request.headers.get("range"), size);

        if (range) {
          // Note: Bun 1.3.x `.slice().stream()` delivers bytes but never
          // signals EOF for larger slices, so buffer the range here. Chunk
          // sizes are renter-controlled (rowsPerChunk/itemsPerChunk), so
          // buffered slices stay bounded in practice.
          const buf = Buffer.from(await file.slice(range.start, range.end + 1).arrayBuffer());
          return new Response(buf, {
            status: 206,
            headers: {
              "Content-Type": contentTypeFor(key),
              "Content-Length": String(range.end - range.start + 1),
              "Accept-Ranges": "bytes",
              "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
            },
          });
        }

        const headers: Record<string, string> = {
          "Content-Type": contentTypeFor(key),
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
        };
        if (url.searchParams.get("download") === "1") {
          headers["Content-Disposition"] = `attachment; filename="${key.split("/").pop()}"`;
        }
        return new Response(file.stream(), { status: 200, headers });
      }

      // PUT
      if (!request.body) {
        return status(400, { message: "Empty body" });
      }
      // Bun.write accepts this stringified stream trick, but for correctness
      // buffer the body first (v1: chunk outputs and datasets are modest).
      const data = Buffer.from(await request.arrayBuffer());
      await Bun.write(objectFilePath(key), data);
      return { message: "Stored", key, bytes: data.byteLength };
    } catch (error) {
      return status(400, {
        message: error instanceof Error ? error.message : "Storage error",
      });
    }
  })

  .listen({
    hostname: "0.0.0.0",
    port: 6767,
  });

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);