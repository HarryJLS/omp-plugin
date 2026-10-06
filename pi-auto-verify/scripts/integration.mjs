import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const piRoot = resolve(process.env.PI_SOURCE_DIR || resolve(root, "../../pi"));
const result = spawnSync(process.execPath, [
  resolve(piRoot, "node_modules/vitest/vitest.mjs"), "run",
  "--config", resolve(root, "vitest.config.mjs"), "--configLoader", "native",
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PI_SOURCE_DIR: piRoot, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
