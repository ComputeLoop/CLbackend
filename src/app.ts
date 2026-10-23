import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CORS_ORIGINS } from "./config";
import { listOperations, toPublicOperation } from "./services/operations";
import { authRoutes } from "./routes/auth";
import { projectRoutes } from "./routes/projects";
import { exploreRoutes } from "./routes/explore";
import { chunkRoutes } from "./routes/chunks";
import { workerRoutes } from "./routes/workers";
import { walletRoutes } from "./routes/wallet";
import { storageRoutes } from "./routes/storage";

export const app = new Elysia()
  .use(
    cors({
      origin: CORS_ORIGINS,
      credentials: true,
    }),
  )
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
  .get("/operations", () => listOperations().map(toPublicOperation))
  .use(authRoutes)
  .use(projectRoutes)
  .use(exploreRoutes)
  .use(chunkRoutes)
  .use(workerRoutes)
  .use(walletRoutes)
  .use(storageRoutes);
