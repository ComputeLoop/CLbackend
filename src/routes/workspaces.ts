import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import AdmZip from "adm-zip";
import { Elysia, t } from "elysia";
import { sqlite } from "../db";
import { requireUser } from "../services/auth";
import { objectFile, objectPath, writeObject } from "../services/storage";

export class WorkspaceError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}
function reject(status: number, message: string): never {
  throw new WorkspaceError(status, message);
}
type Role = "owner" | "admin" | "member";
type Actor = { userId: string };
type App = {
  id: string;
  source_url: string | null;
  package_id: string | null;
  instructions: string;
  gpu: number;
  digest: string;
  bytes: number;
};
type Task = {
  id: string;
  state: string;
  claimed_by: string | null;
  lease: string | null;
  expires: number | null;
};
const FREE = 3;
const PAID = 10;
const MONTH = 30 * 86400_000;
const CLAIM_MS = 24 * 60 * 60_000;
const positiveSetting = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000
    ? value
    : fallback;
};
const PRICE = positiveSetting("DEMO_SUBSCRIPTION_COINS", 30);
const IDR = positiveSetting("DEMO_IDR_PER_COIN", 1000);
const MiB = 1024 * 1024;
const cookieActor = (cookie: Parameters<typeof requireUser>[0]): Actor => {
  const user = requireUser(cookie);
  if (!user) reject(401, "Sign in first.");
  return { userId: user.id };
};
function membership(
  workspace: string,
  actor: Actor,
  access: "all" | "admin" | "owner" = "all",
) {
  const row = sqlite
    .query(
      `SELECT m.role, w.name, w.paid_until FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.workspace_id = ? AND m.user_id = ?`,
    )
    .get(workspace, actor.userId) as {
    role: Role;
    name: string;
    paid_until: number;
  } | null;
  if (!row) reject(404, "Workspace not found.");
  if (
    (access === "admin" && row.role === "member") ||
    (access === "owner" && row.role !== "owner")
  )
    reject(403, "Your role cannot do that.");
  return row;
}
function list(user: string) {
  return sqlite
    .query(
      `SELECT w.id, w.name, w.paid_until AS paidUntil, (w.paid_until > ?) AS paid, m.role FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at DESC`,
    )
    .all(Date.now(), user);
}
function application(workspace: string, id: string) {
  const row = sqlite
    .query(
      "SELECT id, source_url, package_id, instructions, gpu, digest, bytes FROM team_apps WHERE id = ? AND workspace_id = ?",
    )
    .get(id, workspace) as App | null;
  if (!row) reject(404, "Worker not found.");
  return row;
}
function workerInUse(id: string) {
  return Boolean(sqlite.query("SELECT 1 FROM team_jobs WHERE app_id = ? LIMIT 1").get(id));
}
function task(workspace: string, id: string) {
  const row = sqlite
    .query(
      `SELECT t.*, j.app_id FROM team_tasks t JOIN team_jobs j ON j.id = t.job_id
    WHERE t.id = ? AND j.workspace_id = ?`,
    )
    .get(id, workspace) as (Task & { app_id: string }) | null;
  if (!row) reject(404, "Task not found.");
  return row;
}
function expire() {
  sqlite.run(
    "UPDATE team_tasks SET state = 'pending', claimed_by = NULL, worker_id = NULL, lease = NULL, expires = NULL WHERE state = 'running' AND (claimed_by IS NULL OR expires <= ?)",
    [Date.now()],
  );
}
function assertClaim(row: Task, actor: Actor) {
  if (
    row.state !== "running" ||
    !row.lease ||
    row.claimed_by !== actor.userId ||
    (row.expires ?? 0) <= Date.now()
  ) {
    reject(409, "You need an active claim on this task.");
  }
  return row.lease;
}
async function fileDownload(key: string, name: string, type: string) {
  const file = objectFile(key);
  if (!(await file.exists())) reject(404, "File not found.");
  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
const appKey = (id: string) => `teams/apps/${id}.zip`;
const workerPackageKey = (app: Pick<App, "id" | "package_id">) => appKey(app.package_id ?? app.id);
async function removeWorkerPackage(key: string) {
  try {
    await rm(objectPath(key), { force: true });
    return true;
  } catch (error) {
    console.error(`Worker package cleanup failed (${key}):`, error);
    return false;
  }
}
const inputKey = (id: string) => `teams/inputs/${id}.zip`;
const resultDirectory = (id: string) => `teams/results/${id}`;
const resultKey = (id: string, lease: string) =>
  `${resultDirectory(id)}/${lease}.json`;
const name = t.String({ minLength: 1, maxLength: 96 });
const taskManifest = t.Array(
  t.Object({
    label: name,
    args: t.Array(t.String({ maxLength: 1000 }), { maxItems: 32 }),
    inputIndex: t.Optional(t.Integer({ minimum: 0 })),
  }),
  { minItems: 1, maxItems: 100 },
);
function httpsLink(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    reject(400, "Enter a valid HTTPS link to the worker release or download.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    reject(400, "Use an HTTPS link without embedded credentials.");
  return url.href;
}
const workerForm = t.Object({
  name,
  device: t.Union([t.Literal("cpu"), t.Literal("gpu")]),
  instructions: t.String({ maxLength: 8000 }),
  sourceUrl: t.Optional(t.String({ maxLength: 2000 })),
  package: t.Optional(t.File({ maxSize: 32 * MiB })),
});
function workerFields(body: typeof workerForm.static) {
  const source = body.sourceUrl?.trim();
  const name = body.name.trim();
  const instructions = body.instructions.trim();
  if (!name) reject(400, "Enter a worker name.");
  if (source && body.package) reject(400, "Choose either a worker ZIP or a download link.");
  return { name, instructions, sourceUrl: source ? httpsLink(source) : null, gpu: body.device === "gpu" ? 1 : 0 };
}
async function readWorkerPackage(file: File) {
  const content = Buffer.from(await file.arrayBuffer());
  try {
    const entries = new AdmZip(content).getEntries();
    if (!entries.some((entry) => !entry.isDirectory))
      reject(400, "The worker ZIP must contain at least one file.");
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    reject(400, "Upload a valid ZIP package.");
  }
  return { content, digest: createHash("sha256").update(content).digest("hex") };
}
function assertRunnableWorker(workspace: string, id: string) {
  if (!application(workspace, id).instructions)
    reject(409, "Publish a worker with run instructions before creating new tasks.");
}

export const workspaceRoutes = new Elysia({ prefix: "/team" })
  .get("/me", ({ cookie }) => {
    const { userId } = cookieActor(cookie);
    const balance = sqlite
      .query("SELECT balance FROM demo_wallets WHERE user_id = ?")
      .get(userId) as { balance: number } | null;
    return {
      workspaces: list(userId),
      balance: balance?.balance ?? 0,
      freeLimit: FREE,
      paidLimit: PAID,
      price: PRICE,
      idrPerCoin: IDR,
      invites: sqlite
        .query(
          "SELECT w.id, w.name FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.user_id = ?",
        )
        .all(userId),
      transactions: sqlite
        .query(
          "SELECT amount, kind, at FROM demo_ledger WHERE user_id = ? ORDER BY at DESC LIMIT 20",
        )
        .all(userId),
    };
  })
  .post(
    "/workspaces",
    ({ body, cookie }) => {
      const { userId } = cookieActor(cookie);
      const id = crypto.randomUUID();
      if (!body.name.trim()) reject(400, "Enter a workspace name.");
      sqlite
        .transaction(() => {
          sqlite.run(
            "INSERT INTO workspaces(id, name, created_at) VALUES (?, ?, ?)",
            [id, body.name.trim(), Date.now()],
          );
          sqlite.run("INSERT INTO workspace_members VALUES (?, ?, 'owner')", [
            id,
            userId,
          ]);
        })
        .immediate();
      return { id };
    },
    { body: t.Object({ name }) },
  )
  .post(
    "/workspaces/:id/delete",
    async ({ params, body, cookie }) => {
      const actor = cookieActor(cookie);
      const { id } = params;
      const { apps, tasks } = sqlite
        .transaction(() => {
          const workspace = membership(id, actor, "owner");
          if (body.confirmName !== workspace.name)
            reject(400, "Type the exact workspace name to confirm deletion.");

          const apps = sqlite
            .query(
              "SELECT id, package_id FROM team_apps WHERE workspace_id = ? AND source_url IS NULL",
            )
            .all(id) as Pick<App, "id" | "package_id">[];
          const tasks = sqlite
            .query(
              `SELECT t.id FROM team_tasks t JOIN team_jobs j ON j.id = t.job_id
        WHERE j.workspace_id = ?`,
            )
            .all(id) as { id: string }[];
          sqlite.run(
            "DELETE FROM team_tasks WHERE job_id IN (SELECT id FROM team_jobs WHERE workspace_id = ?)",
            [id],
          );
          sqlite.run("DELETE FROM team_jobs WHERE workspace_id = ?", [id]);
          sqlite.run("DELETE FROM team_apps WHERE workspace_id = ?", [id]);
          sqlite.run("DELETE FROM workspace_invites WHERE workspace_id = ?", [
            id,
          ]);
          sqlite.run("DELETE FROM workspace_members WHERE workspace_id = ?", [
            id,
          ]);
          sqlite.run("DELETE FROM workspaces WHERE id = ?", [id]);
          return { apps, tasks };
        })
        .immediate();

      const cleanup = await Promise.allSettled([
        ...apps.map((app) => rm(objectPath(workerPackageKey(app)), { force: true })),
        ...tasks.flatMap((task) => [
          rm(objectPath(inputKey(task.id)), { force: true }),
          rm(objectPath(resultDirectory(task.id)), {
            recursive: true,
            force: true,
          }),
        ]),
      ]);
      const failures = cleanup.filter((result) => result.status === "rejected");
      if (failures.length)
        console.error(
          `Workspace ${id} file cleanup failed:`,
          failures.map((failure) => failure.reason),
        );
      return { cleanupComplete: failures.length === 0 };
    },
    { body: t.Object({ confirmName: name }) },
  )
  .post(
    "/top-up",
    ({ body, cookie }) => {
      const { userId } = cookieActor(cookie);
      sqlite
        .transaction(() => {
          sqlite.run(
            "INSERT INTO demo_wallets VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance",
            [userId, body.coins],
          );
          sqlite.run(
            "INSERT INTO demo_ledger VALUES (?, ?, NULL, ?, 'top-up', ?)",
            [crypto.randomUUID(), userId, body.coins, Date.now()],
          );
        })
        .immediate();
      return { simulatedIdr: body.coins * IDR };
    },
    { body: t.Object({ coins: t.Integer({ minimum: 1, maximum: 1000 }) }) },
  )
  .post("/workspaces/:id/subscribe", ({ params, cookie }) => {
    const actor = cookieActor(cookie);
    return sqlite
      .transaction(() => {
        const row = membership(params.id, actor, "owner");
        const now = Date.now();
        if (
          !sqlite.run(
            "UPDATE demo_wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?",
            [PRICE, actor.userId, PRICE],
          ).changes
        ) {
          reject(409, "Not enough Compute coins. Use Top up in the header and try again.");
        }
        const paidUntil = Math.max(now, row.paid_until) + MONTH;
        sqlite.run("UPDATE workspaces SET paid_until = ? WHERE id = ?", [
          paidUntil,
          params.id,
        ]);
        sqlite.run(
          "INSERT INTO demo_ledger VALUES (?, ?, ?, ?, 'subscription', ?)",
          [crypto.randomUUID(), actor.userId, params.id, -PRICE, now],
        );
        return { paidUntil };
      })
      .immediate();
  })
  .post(
    "/workspaces/:id/invites",
    ({ params, body, cookie }) => {
      membership(params.id, cookieActor(cookie), "owner");
      const user = sqlite
        .query("SELECT id FROM users WHERE username = ?")
        .get(body.username.trim()) as { id: string } | null;
      if (!user) reject(404, "No account has that username.");
      if (
        sqlite
          .query(
            "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
          )
          .get(params.id, user.id)
      )
        reject(409, "Already a member.");
      sqlite.run("INSERT OR IGNORE INTO workspace_invites VALUES (?, ?)", [
        params.id,
        user.id,
      ]);
      return { ok: true };
    },
    { body: t.Object({ username: name }) },
  )
  .post("/workspaces/:id/join", ({ params, cookie }) => {
    const { userId } = cookieActor(cookie);
    return sqlite
      .transaction(() => {
        const invite = sqlite
          .query(
            `SELECT w.paid_until FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.workspace_id = ? AND i.user_id = ?`,
          )
          .get(params.id, userId) as { paid_until: number } | null;
        if (!invite) reject(404, "Invitation not found.");
        const count = sqlite
          .query(
            "SELECT count(*) AS n FROM workspace_members WHERE workspace_id = ?",
          )
          .get(params.id) as { n: number };
        if (count.n >= (invite.paid_until > Date.now() ? PAID : FREE))
          reject(409, "This workspace has no free seats.");
        sqlite.run("INSERT INTO workspace_members VALUES (?, ?, 'member')", [
          params.id,
          userId,
        ]);
        sqlite.run(
          "DELETE FROM workspace_invites WHERE workspace_id = ? AND user_id = ?",
          [params.id, userId],
        );
        return { ok: true };
      })
      .immediate();
  })
  .post(
    "/workspaces/:id/members/:userId",
    ({ params, body, cookie }) => {
      membership(params.id, cookieActor(cookie), "owner");
      sqlite
        .transaction(() => {
          const member = sqlite
            .query(
              "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
            )
            .get(params.id, params.userId) as { role: Role } | null;
          if (!member || member.role === "owner")
            reject(400, "Choose an admin or member.");
          if (body.role === "remove") {
            sqlite.run(
              "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
              [params.id, params.userId],
            );
            sqlite.run(
              `UPDATE team_tasks SET state = 'pending', claimed_by = NULL, expires = NULL, lease = NULL
          WHERE state = 'running' AND claimed_by = ?
          AND job_id IN (SELECT id FROM team_jobs WHERE workspace_id = ?)`,
              [params.userId, params.id],
            );
          } else {
            sqlite.run(
              "UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?",
              [body.role, params.id, params.userId],
            );
          }
        })
        .immediate();
      return { ok: true };
    },
    {
      body: t.Object({
        role: t.Union([
          t.Literal("member"),
          t.Literal("admin"),
          t.Literal("remove"),
        ]),
      }),
    },
  )
  .get("/workspaces/:id", ({ params, cookie }) => {
    const actor = cookieActor(cookie);
    const { role, paid_until } = membership(params.id, actor);
    expire();
    return {
      role,
      paidUntil: paid_until,
      paid: paid_until > Date.now(),
      members: sqlite
        .query(
          `SELECT u.id, u.username, m.role
        FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.username`,
        )
        .all(params.id),
      apps: sqlite
        .query(
          "SELECT id, name, gpu, source_url AS sourceUrl, instructions FROM team_apps WHERE workspace_id = ? ORDER BY rowid DESC",
        )
        .all(params.id),
      jobs: sqlite
        .query(
          "SELECT id, name, app_id AS appId, result_instructions AS resultInstructions FROM team_jobs WHERE workspace_id = ? ORDER BY created_at DESC",
        )
        .all(params.id),
      tasks: sqlite
        .query(
          `SELECT t.id, t.job_id AS jobId, t.label, t.args, t.state, t.error, t.input_bytes AS inputBytes,
        t.claimed_by AS claimedBy, u.username AS assignee, t.expires AS claimExpiresAt
        FROM team_tasks t JOIN team_jobs j ON j.id = t.job_id
        LEFT JOIN users u ON u.id = t.claimed_by WHERE j.workspace_id = ? ORDER BY t.position`,
        )
        .all(params.id),
    };
  })
  .post(
    "/workspaces/:id/apps",
    async ({ params, body, cookie }) => {
      const actor = cookieActor(cookie);
      membership(params.id, actor, "admin");
      const worker = workerFields(body);
      if (!worker.sourceUrl && !body.package)
        reject(400, "Upload a worker ZIP or provide a download link.");
      if (!worker.instructions) reject(400, "Enter run instructions for your members.");
      const id = crypto.randomUUID();
      const upload = body.package ? await readWorkerPackage(body.package) : null;
      try {
        if (upload) await writeObject(appKey(id), upload.content);
        membership(params.id, actor, "admin");
        sqlite.run(
          `INSERT INTO team_apps(id, workspace_id, name, gpu, digest, bytes, source_url, instructions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            params.id,
            worker.name,
            worker.gpu,
            upload?.digest ?? "",
            upload?.content.length ?? 0,
            worker.sourceUrl,
            worker.instructions,
          ],
        );
      } catch (error) {
        if (upload) await removeWorkerPackage(appKey(id));
        throw error;
      }
      return { id };
    },
    { body: workerForm },
  )
  .post(
    "/workspaces/:id/apps/:appId",
    async ({ params, body, cookie }) => {
      const actor = cookieActor(cookie);
      membership(params.id, actor, "admin");
      const worker = workerFields(body);
      const check = (app: App) => {
        if (workerInUse(app.id)) {
          if (body.package || (worker.sourceUrl && worker.sourceUrl !== app.source_url) || worker.gpu !== app.gpu || worker.instructions !== app.instructions)
            reject(409, "Jobs already use this worker. Publish a new worker to change its files, hardware requirements, or run instructions.");
        } else if (!worker.instructions) {
          reject(400, "Enter run instructions for your members.");
        }
      };
      check(application(params.id, params.appId));
      const upload = body.package ? await readWorkerPackage(body.package) : null;
      const packageId = upload ? crypto.randomUUID() : null;
      let previousPackage: string | null;
      try {
        if (upload && packageId) await writeObject(appKey(packageId), upload.content);
        previousPackage = sqlite.transaction(() => {
          membership(params.id, actor, "admin");
          const app = application(params.id, params.appId);
          check(app);
          const changedSource = Boolean(upload || worker.sourceUrl);
          sqlite.run(
            "UPDATE team_apps SET name = ?, gpu = ?, instructions = ?, source_url = ?, package_id = ?, digest = ?, bytes = ? WHERE id = ?",
            [worker.name, worker.gpu, worker.instructions,
              changedSource ? worker.sourceUrl : app.source_url,
              changedSource ? packageId : app.package_id,
              changedSource ? upload?.digest ?? "" : app.digest,
              changedSource ? upload?.content.length ?? 0 : app.bytes, app.id],
          );
          return changedSource && !app.source_url ? workerPackageKey(app) : null;
        }).immediate();
      } catch (error) {
        if (packageId) await removeWorkerPackage(appKey(packageId));
        throw error;
      }
      return { cleanupComplete: !previousPackage || await removeWorkerPackage(previousPackage) };
    },
    { body: workerForm },
  )
  .post("/workspaces/:id/apps/:appId/delete", async ({ params, cookie }) => {
    const actor = cookieActor(cookie);
    const app = sqlite.transaction(() => {
      membership(params.id, actor, "admin");
      const app = application(params.id, params.appId);
      if (workerInUse(app.id)) reject(409, "This worker cannot be deleted because it is used by a job.");
      sqlite.run("DELETE FROM team_apps WHERE id = ?", [app.id]);
      return app;
    }).immediate();
    return { cleanupComplete: Boolean(app.source_url) || await removeWorkerPackage(workerPackageKey(app)) };
  })
  .get("/workspaces/:id/apps/:appId/package", ({ params, cookie }) => {
    membership(params.id, cookieActor(cookie));
    const app = application(params.id, params.appId);
    if (app.source_url)
      reject(404, "This worker uses an external download link.");
    return fileDownload(workerPackageKey(app), "worker.zip", "application/zip");
  })
  .post(
    "/workspaces/:id/jobs",
    async ({ params, body, cookie }) => {
      const actor = cookieActor(cookie);
      membership(params.id, actor, "admin");
      assertRunnableWorker(params.id, body.appId);
      const { manifest } = body;
      if (
        manifest.some(
          (row) =>
            !row.label.trim() || row.args.some((arg) => arg.includes("\0")),
        )
      )
        reject(400, "Use nonblank task labels and valid text arguments.");
      if (!body.name.trim()) reject(400, "Enter a job name.");
      const inputs = body.inputs ?? [];
      if (
        manifest.some(
          (row) => row.inputIndex !== undefined && !inputs[row.inputIndex],
        )
      )
        reject(400, "A task references a missing input ZIP.");
      const uploadBytes = manifest.reduce(
        (total, row) =>
          total +
          (row.inputIndex === undefined ? 0 : inputs[row.inputIndex]!.size),
        0,
      );
      if (uploadBytes > 48 * MiB)
        reject(413, "Job inputs must total 48 MiB or less.");
      const jobId = crypto.randomUUID();
      const rows = manifest.map((row) => ({ ...row, id: crypto.randomUUID() }));
      try {
        for (const row of rows) {
          const input =
            row.inputIndex === undefined ? undefined : inputs[row.inputIndex];
          if (input) {
            const bytes = new Uint8Array(await input.arrayBuffer());
            if (bytes[0] !== 0x50 || bytes[1] !== 0x4b)
              reject(400, "Task inputs must be ZIP files.");
            await writeObject(inputKey(row.id), bytes);
          }
        }
        membership(params.id, actor, "admin");
        sqlite
          .transaction(() => {
            assertRunnableWorker(params.id, body.appId);
            sqlite.run(`INSERT INTO team_jobs(id, workspace_id, app_id, name, created_at, result_instructions)
              VALUES (?, ?, ?, ?, ?, ?)`, [
              jobId,
              params.id,
              body.appId,
              body.name.trim(),
              Date.now(),
              body.resultInstructions?.trim() ?? "",
            ]);
            rows.forEach((row, i) => {
              const bytes =
                row.inputIndex === undefined ? 0 : inputs[row.inputIndex]!.size;
              sqlite.run(
                "INSERT INTO team_tasks(id, job_id, position, label, args, input_bytes) VALUES (?, ?, ?, ?, ?, ?)",
                [row.id, jobId, i, row.label, JSON.stringify(row.args), bytes],
              );
            });
          })
          .immediate();
      } catch (error) {
        await Promise.all(
          rows.map((row) => rm(objectPath(inputKey(row.id)), { force: true })),
        );
        throw error;
      }
      return { id: jobId };
    },
    {
      body: t.Object({
        name,
        appId: t.String(),
          manifest: taskManifest,
          inputs: t.Optional(t.Files({ maxSize: 16 * MiB, maxItems: 100 })),
          resultInstructions: t.Optional(t.String({ maxLength: 4000 })),
      }),
    },
  )
  .get("/workspaces/:id/tasks/:taskId/input", ({ params, cookie }) => {
    membership(params.id, cookieActor(cookie));
    task(params.id, params.taskId);
    return fileDownload(
      inputKey(params.taskId),
      "input.zip",
      "application/zip",
    );
  })
  .get("/workspaces/:id/tasks/:taskId/result", ({ params, cookie }) => {
    membership(params.id, cookieActor(cookie));
    const row = task(params.id, params.taskId);
    if (row.state !== "done" || !row.lease)
      reject(404, "Result not available.");
    return fileDownload(
      resultKey(row.id, row.lease),
      "result.json",
      "application/json",
    );
  })
  .get("/workspaces/:id/jobs/:jobId/results", async ({ params, cookie }) => {
    membership(params.id, cookieActor(cookie));
    if (
      !sqlite
        .query("SELECT 1 FROM team_jobs WHERE id = ? AND workspace_id = ?")
        .get(params.jobId, params.id)
    )
      reject(404, "Job not found.");
    const rows = sqlite
      .query(
        "SELECT id, label, lease FROM team_tasks WHERE job_id = ? AND state = 'done' ORDER BY position",
      )
      .all(params.jobId) as { id: string; label: string; lease: string }[];
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode("[\n"));
        try {
          for (const [index, row] of rows.entries()) {
            const value = await objectFile(resultKey(row.id, row.lease)).text();
            controller.enqueue(
              enc.encode(
                `${index ? ",\n" : ""}{"task":${JSON.stringify(row.label)},"result":${value}}`,
              ),
            );
          }
          controller.enqueue(enc.encode("\n]\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="results.json"',
        "Cache-Control": "private, no-store",
      },
    });
  })
  .post("/workspaces/:id/tasks/:taskId/retry", ({ params, cookie }) => {
    membership(params.id, cookieActor(cookie), "admin");
    task(params.id, params.taskId);
    if (
      !sqlite.run(
        "UPDATE team_tasks SET state = 'pending', error = NULL, worker_id = NULL, lease = NULL WHERE id = ? AND state = 'failed'",
        [params.taskId],
      ).changes
    )
      reject(409, "Only failed tasks can be retried.");
    return { ok: true };
  })
  .post("/workspaces/:id/tasks/:taskId/claim", ({ params, cookie }) => {
    const actor = cookieActor(cookie);
    membership(params.id, actor);
    return sqlite
      .transaction(() => {
        expire();
        const row = task(params.id, params.taskId);
        if (row.state !== "pending")
          reject(409, "This task is no longer pending.");
        if (!application(params.id, row.app_id).instructions)
          reject(
            409,
            "Ask the owner to publish a worker with run instructions for this job.",
          );
        if (
          sqlite
            .query(
              "SELECT 1 FROM team_tasks WHERE claimed_by = ? AND state = 'running'",
            )
            .get(actor.userId)
        )
          reject(409, "Finish or release your other claimed task first.");
        const claimExpiresAt = Date.now() + CLAIM_MS;
        sqlite.run(
          "UPDATE team_tasks SET state = 'running', claimed_by = ?, lease = ?, expires = ?, error = NULL WHERE id = ?",
          [actor.userId, crypto.randomUUID(), claimExpiresAt, row.id],
        );
        return { claimExpiresAt };
      })
      .immediate();
  })
  .post("/workspaces/:id/tasks/:taskId/release", ({ params, cookie }) => {
    const actor = cookieActor(cookie);
    membership(params.id, actor);
    const lease = assertClaim(task(params.id, params.taskId), actor);
    sqlite.run(
      "UPDATE team_tasks SET state = 'pending', claimed_by = NULL, expires = NULL, lease = NULL WHERE id = ? AND lease = ?",
      [params.taskId, lease],
    );
    return { ok: true };
  })
  .post(
    "/workspaces/:id/tasks/:taskId/complete",
    async ({ params, cookie, body }) => {
      const actor = cookieActor(cookie);
      membership(params.id, actor);
      const lease = assertClaim(task(params.id, params.taskId), actor);
      const output = await body.result.text();
      try {
        JSON.parse(output);
      } catch {
        reject(400, "Upload a valid result.json file.");
      }
      const path = objectPath(resultKey(params.taskId, lease));
      await mkdir(dirname(path), { recursive: true });
      // Each upload gets its own file. Only the request that still owns the claim publishes it.
      const resultId = crypto.randomUUID();
      const uploadPath = objectPath(resultKey(params.taskId, resultId));
      try {
        await writeFile(uploadPath, output, { flag: "wx" });
        membership(params.id, cookieActor(cookie));
        const changed = sqlite.run(
          `UPDATE team_tasks SET state = 'done', expires = NULL, lease = ?
        WHERE id = ? AND state = 'running' AND claimed_by = ? AND lease = ? AND expires > ?`,
          [resultId, params.taskId, actor.userId, lease, Date.now()],
        );
        if (!changed.changes)
          reject(
            409,
            "Your claim expired or the task has already been submitted.",
          );
      } catch (error) {
        await rm(uploadPath, { force: true });
        throw error;
      }
      return { ok: true };
    },
    { body: t.Object({ result: t.File({ maxSize: 4 * MiB }) }) },
  );
