import { spawn } from "node:child_process";
import { resolve } from "node:path";

void main();

async function main() {
  const buildEnvironment = { ...process.env, E2E_TEST_MODE: "1" };
  const appEnvironment = { ...buildEnvironment, E2E_DATABASE_PATH: "memory://",
    E2E_PROJECT_ROOT: process.cwd(), NODE_ENV: "production", NEXT_RUNTIME: "nodejs" };

  await run(process.execPath, [resolve(process.cwd(), "apps/web/node_modules/next/dist/bin/next"),
    "build", "--webpack"], buildEnvironment, resolve(process.cwd(), "apps/web"));

  const child = spawn(process.execPath, ["--import", "tsx", "scripts/e2e-next-start.ts"], {
    cwd: process.cwd(),
    env: appEnvironment,
    stdio: "inherit",
  });
  let stopping = false;
  async function stop(exitCode: number) {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    process.exit(exitCode);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void stop(0));
  }
  child.on("exit", (code, signal) => void stop(code ?? (signal ? 1 : 0)));
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const buildProcess = spawn(command, args, { cwd, env, stdio: "inherit" });
    buildProcess.on("error", rejectRun);
    buildProcess.on("exit", (code, signal) => code === 0
      ? resolveRun()
      : rejectRun(new Error(`E2E build exited with ${code ?? signal ?? "unknown status"}`)));
  });
}
