import { Elysia, t } from "elysia";
import { db } from "./database";

const app = new Elysia()
  .get("/", () => ({
    name: "Compute Loop",
    status: "online",
  }))

  .get("/health", () => ({
    status: "ok",
  }))

  .get("/projects", () => {
    return db
      .query(
        `
        SELECT
          id,
          name,
          description,
          total_jobs AS totalJobs,
          completed_jobs AS completedJobs,
          status
        FROM projects
        ORDER BY created_at DESC
      `,
      )
      .all();
  })

  .post(
    "/projects",
    ({ body }) => {
      const projectId = crypto.randomUUID();
      const createdAt = new Date().toISOString();

      db.run(
        `
          INSERT INTO projects (
            id,
            name,
            description,
            total_jobs,
            completed_jobs,
            status,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          projectId,
          body.name,
          body.description,
          body.totalJobs,
          0,
          "OPEN",
          createdAt,
        ],
      );

      const rangeSize = 10_000;

      for (let i = 1; i <= body.totalJobs; i++) {
        const start = (i - 1) * rangeSize + 1;
        const end = i * rangeSize;

        db.run(
          `
            INSERT INTO jobs (
              id,
              project_id,
              job_number,
              status,
              input_start,
              input_end
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          [crypto.randomUUID(), projectId, i, "PENDING", start, end],
        );
      }

      return {
        id: projectId,
        name: body.name,
        description: body.description,
        totalJobs: body.totalJobs,
        completedJobs: 0,
        status: "OPEN",
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

  .get("/projects/:id/jobs", ({ params }) => {
    return db
      .query(
        `
        SELECT
          id,
          project_id AS projectId,
          job_number AS jobNumber,
          status,
          worker_id AS workerId,
          input_start AS inputStart,
          input_end AS inputEnd,
          result
        FROM jobs
        WHERE project_id = ?
        ORDER BY job_number
      `,
      )
      .all(params.id);
  })
  .get(
    "/jobs/next",
    ({ query, status }) => {
      const workerId = query.workerId;

      const job = db
        .query(
          `
        SELECT
          id,
          project_id AS projectId,
          job_number AS jobNumber,
          status,
          worker_id AS workerId,
          input_start AS inputStart,
          input_end AS inputEnd,
          result
        FROM jobs
        WHERE status = 'PENDING'
        ORDER BY job_number
        LIMIT 1
      `,
        )
        .get() as {
        id: string;
        projectId: string;
        jobNumber: number;
        status: "PENDING" | "RUNNING" | "COMPLETED";
        workerId?: string;
        inputStart: number;
        inputEnd: number;
        result?: string;
      } | null;

      if (!job) {
        return status(404, {
          message: "No jobs available",
        });
      }

      db.run(
        `
        UPDATE jobs
        SET status = 'RUNNING',
            worker_id = ?
        WHERE id = ?
      `,
        [workerId, job.id],
      );

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
      }),
    },
  )
  .post(
    "/jobs/:id/complete",
    ({ params, body, status }) => {
      const job = db
        .query(
          `
        SELECT
          id,
          project_id AS projectId,
          job_number AS jobNumber,
          status,
          worker_id AS workerId,
          input_start AS inputStart,
          input_end AS inputEnd,
          result
        FROM jobs
        WHERE id = ?
      `,
        )
        .get(params.id) as {
        id: string;
        projectId: string;
        jobNumber: number;
        status: "PENDING" | "RUNNING" | "COMPLETED";
        workerId?: string;
        inputStart: number;
        inputEnd: number;
        result?: string;
      } | null;

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

      db.run(
        `
        UPDATE jobs
        SET status = 'COMPLETED',
            result = ?
        WHERE id = ?
      `,
        [body.result, params.id],
      );

      db.run(
        `
        UPDATE projects
        SET completed_jobs = completed_jobs + 1
        WHERE id = ?
      `,
        [job.projectId],
      );

      const project = db
        .query(
          `
        SELECT
          id,
          name,
          description,
          total_jobs AS totalJobs,
          completed_jobs AS completedJobs,
          status
        FROM projects
        WHERE id = ?
      `,
        )
        .get(job.projectId) as {
        id: string;
        name: string;
        description: string;
        totalJobs: number;
        completedJobs: number;
        status: string;
      } | null;

      if (project && project.completedJobs >= project.totalJobs) {
        db.run(
          `
          UPDATE projects
          SET status = 'COMPLETED'
          WHERE id = ?
        `,
          [job.projectId],
        );

        project.status = "COMPLETED";
      } else if (project) {
        db.run(
          `
          UPDATE projects
          SET status = 'RUNNING'
          WHERE id = ?
        `,
          [job.projectId],
        );

        project.status = "RUNNING";
      }

      return {
        message: "Job completed",
        job: {
          ...job,
          status: "COMPLETED",
          result: body.result,
        },
        project,
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
