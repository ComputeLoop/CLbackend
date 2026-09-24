import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../db";
import { datasets, jobs, projects } from "../db/schema";
import { CLAIM_TTL_MS } from "../config";
import { getOperation } from "./operations";
import { readObject, writeObject } from "./storage";

export const projectFields = {
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

export const jobFields = {
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

export const JSONL_OPS = new Set(["image-hash", "image-classify"]);

export function getProject(id: string) {
  return db.select(projectFields).from(projects).where(eq(projects.id, id)).get();
}

export function getDataset(id: string) {
  return db.select().from(datasets).where(eq(datasets.id, id)).get();
}

export function sanitizeFilename(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return cleaned || "file";
}

export function sweepStaleJobs() {
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

export function claimJob(workerId: string, projectId: string, outputKey: string) {
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
      .run() as unknown as { changes: number };

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

export async function mergeProject(projectId: string) {
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
    .run() as unknown as { changes: number };

  if (claimed.changes === 0) {
    return { merged: false, reason: "already merged" };
  }

  const projectAfter = getProject(projectId);
  return { merged: true, mergedKey, project: projectAfter };
}
