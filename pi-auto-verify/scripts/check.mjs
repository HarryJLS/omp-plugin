import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const piRoot = resolve(process.env.PI_SOURCE_DIR || resolve(root, "../../pi"));
const temporary = mkdtempSync(join(tmpdir(), "pi-auto-verify-types-"));
try {
  const source = JSON.parse(readFileSync(resolve(piRoot, "tsconfig.json"), "utf8"));
  const paths = Object.fromEntries(Object.entries(source.compilerOptions.paths)
    .map(([name, entries]) => [name, entries.map((path) => resolve(piRoot, path))]));
  paths["@pi-test/harness"] = [resolve(piRoot, "packages/coding-agent/test/suite/harness.ts")];
  paths["@pi-test/utilities"] = [resolve(piRoot, "packages/coding-agent/test/utilities.ts")];
  paths["@pi-test/loader"] = [resolve(piRoot, "packages/coding-agent/src/core/extensions/loader.ts")];
  paths.vitest = [resolve(piRoot, "node_modules/vitest/dist/index.d.ts")];
  const config = join(temporary, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    extends: resolve(piRoot, "tsconfig.json"),
    compilerOptions: {
      paths,
      typeRoots: [resolve(piRoot, "node_modules/@types")],
      noEmit: true,
    },
    include: [resolve(root, "src/**/*.ts"), resolve(root, "test/*.ts"), resolve(piRoot, "packages/*/src/**/*.d.ts")],
    exclude: [],
  }));
  const run = spawnSync(process.execPath, [resolve(piRoot, "node_modules/typescript/bin/tsc"), "-p", config], {
    cwd: root, stdio: "inherit",
  });
  if (run.error) console.error(run.error.message);
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
