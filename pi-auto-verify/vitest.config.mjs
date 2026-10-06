import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinModules } from "node:module";

const piRoot = process.env.PI_SOURCE_DIR;
if (!piRoot) throw new Error("请使用 npm run test:integration 并指定 PI_SOURCE_DIR");
const { default: base } = await import(pathToFileURL(resolve(piRoot, "vitest.base.ts")).href);

export default {
  ...base,
  resolve: {
    alias: [
      ...base.resolve.alias,
      ...builtinModules.filter((name) => !name.startsWith("node:"))
        .map((name) => ({ find: name, replacement: `node:${name}` })),
      { find: "vitest", replacement: resolve(piRoot, "node_modules/vitest/dist/index.js") },
      { find: "@pi-test/harness", replacement: resolve(piRoot, "packages/coding-agent/test/suite/harness.ts") },
      { find: "@pi-test/utilities", replacement: resolve(piRoot, "packages/coding-agent/test/utilities.ts") },
      { find: "@pi-test/loader", replacement: resolve(piRoot, "packages/coding-agent/src/core/extensions/loader.ts") },
    ],
  },
  test: {
    include: ["test/*.integration.ts"],
    environment: "node",
    env: { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    testTimeout: 30000,
    fileParallelism: false,
    server: { deps: { external: [/@silvia-odwyer\/photon-node/] } },
  },
};
