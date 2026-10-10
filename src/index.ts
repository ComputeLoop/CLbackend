import { app } from "./app";
import { HOSTNAME, PORT } from "./config";

app.listen({
  hostname: HOSTNAME,
  port: PORT,
});

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);

export { app };