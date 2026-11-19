import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { CORS_ORIGINS, PUBLIC_API_URL } from "./config";
import { authRoutes } from "./routes/auth";
import { workspaceRoutes, WorkspaceError } from "./routes/workspaces";

export const app = new Elysia()
  .use(
    cors({
      origin: CORS_ORIGINS,
      credentials: true,
    }),
  )
  .onRequest(({ request, status }) => {
    const origin = request.headers.get("origin");
    if (request.method === "POST" && origin && origin !== PUBLIC_API_URL && !CORS_ORIGINS.includes(origin)) {
      return status(403, { message: "Origin is not allowed." });
    }
  })
  .onError(({ code, error, set, path }) => {
    if (error instanceof WorkspaceError) {
      set.status = error.httpStatus;
      return { message: error.message };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { message: error.message };
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { message: "Not found" };
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
  .use(authRoutes)
  .use(workspaceRoutes);
