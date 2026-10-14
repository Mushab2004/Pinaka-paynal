import { createApp } from "./app";
import { env } from "./config/env";
import { pool } from "./config/database";

async function main() {
  const app = createApp();

  const server = app.listen(env.port, () => {
    console.log(`[server] LanaoCrafts API on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => undefined);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[server] failed to start:", err);
  process.exit(1);
});
