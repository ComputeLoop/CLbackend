import { Elysia } from "elysia";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { datasets, jobs, projects, users } from "../db/schema";
import { requireUser } from "../services/auth";
import { getOperation } from "../services/operations";

export const exploreRoutes = new Elysia({ prefix: "/explore" })
  .get("/", async ({ cookie, status }) => {
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
  });
