import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = path.join(root, "server");

const children = [];

function start(label, command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", shell: true });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
    }
    shutdown();
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) {
    try { child.kill(); } catch { /* ignore */ }
  }
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

console.log("[dev] starting backend (server/) and Vite (root)...");
start("server", "npm", ["run", "dev"], serverDir);
start("vite", "npm", ["run", "dev:vite"], root);
