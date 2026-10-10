import { Elysia, t } from "elysia";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { datasets, jobs, projects } from "../db/schema";
import { requireUser } from "../services/auth";
import {
  getProject,
  getDataset,
  projectFields,
  jobFields,
  sanitizeFilename,
  mergeProject,
} from "../services/projects";
import { getOperation } from "../services/operations";
import {
  detectFormat,
  extractFileList,
  scanTabular,
  planChunks,
} from "../services/dataset";
import { signUrl, writeObject } from "../services/storage";

export const projectRoutes = new Elysia({ prefix: "/projects" })
  .get("/", async ({ cookie, status }) => {
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
  .post(
    "/",
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
  .get("/:id", ({ params, cookie, status }) => {
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
  .get("/:id/jobs", async ({ params, cookie, status }) => {
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
  .post(
    "/:id/dataset",
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
    "/:id/split",
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

      const chunkSize =
        op.splitKind === "file-list"
          ? body.itemsPerChunk ?? op.defaultChunkSize
          : body.rowsPerChunk ?? op.defaultChunkSize;

      let extra: {
        files?: Awaited<ReturnType<typeof extractFileList>>["files"];
        scan?: Awaited<ReturnType<typeof scanTabular>>;
      };

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
  .post("/:id/requeue", ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "Only the project owner can requeue" });
    }

    const requeued = db.transaction((tx) => {
      const updateResult = tx
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
        .run() as unknown as { changes: number };

      const count = updateResult.changes;
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
  .post("/:id/merge", async ({ params, cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const project = getProject(params.id);
    if (!project) return status(404, { message: "Project not found" });
    if (project.ownerId !== user.id) {
      return status(403, { message: "Only the project owner can merge" });
    }

    return await mergeProject(project.id);
  })
  .get("/:id/result", ({ params, cookie, status }) => {
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
  });
