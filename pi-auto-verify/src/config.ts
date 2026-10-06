import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  enabled: boolean;
  maxRounds: number;
  timeoutSeconds: number;
  requireE2E: boolean;
  reviewer: "off" | "current";
}

export const defaults: Config = { enabled: true, maxRounds: 3, timeoutSeconds: 120, requireE2E: false, reviewer: "off" };

export async function loadConfig(cwd: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".pi", "auto-verify.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`未知配置项：${key}`);
  }
  if (data.reviewer !== undefined && data.reviewer !== "off" && data.reviewer !== "current") {
    throw new Error("reviewer 必须是 off 或 current");
  }
  for (const key of ["enabled", "requireE2E"] as const) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") throw new Error(`${key} 必须是布尔值`);
  }
  for (const [key, max] of [["maxRounds", 10], ["timeoutSeconds", 1800]] as const) {
    if (data[key] !== undefined && (!Number.isInteger(data[key]) || Number(data[key]) < 1 || Number(data[key]) > max)) {
      throw new Error(`${key} 必须是 1 到 ${max} 的整数`);
    }
  }
  return { ...defaults, ...data } as Config;
}
