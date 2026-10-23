import { desc, eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { creditTransactions, users } from "../db/schema";
import { requireUser } from "../services/auth";

export const walletRoutes = new Elysia({ prefix: "/wallet" }).get(
  "/",
  ({ cookie, status }) => {
    const user = requireUser(cookie);
    if (!user) return status(401, { message: "Not authenticated" });

    const account = db
      .select({ credits: users.creditBalance })
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    const transactions = db
      .select({
        id: creditTransactions.id,
        projectId: creditTransactions.projectId,
        jobId: creditTransactions.jobId,
        kind: creditTransactions.kind,
        amount: creditTransactions.amount,
        note: creditTransactions.note,
        createdAt: creditTransactions.createdAt,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, user.id))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(50)
      .all();

    return { credits: account?.credits ?? 0, transactions, currency: "mock credits" };
  },
);
