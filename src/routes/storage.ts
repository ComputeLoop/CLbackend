import { Elysia } from "elysia";
import {
  contentTypeFor,
  objectFile,
  objectFilePath,
  parseRange,
  verifySignature,
} from "../services/storage";

export const storageRoutes = new Elysia({ prefix: "/storage" })
  .all("/*", async ({ request, status }) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/");
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
        const file = objectFile(key);
        if (!(await file.exists())) {
          return status(404, { message: "Object not found" });
        }
        const size = file.size;
        const range = parseRange(request.headers.get("range"), size);

        if (range) {
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

      if (!request.body) {
        return status(400, { message: "Empty body" });
      }

      const data = Buffer.from(await request.arrayBuffer());
      await Bun.write(objectFilePath(key), data);
      return { message: "Stored", key, bytes: data.byteLength };
    } catch (error) {
      return status(400, {
        message: error instanceof Error ? error.message : "Storage error",
      });
    }
  });
