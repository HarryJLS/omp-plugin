import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_BYTES = 16 * 1024 * 1024;

export type Snapshot = { kind: "git"; digest: string } | { kind: "no-git" } | { kind: "error"; reason: string };

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    signal,
    timeout: 5000,
    maxBuffer: MAX_BYTES,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  return result.stdout;
}

export async function snapshot(cwd: string, signal?: AbortSignal): Promise<Snapshot> {
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository|spawn git ENOENT/.test(message)) return { kind: "no-git" };
    return { kind: "error", reason: "无法读取 Git 工作区；不能确认验证证据是否仍然有效。" };
  }
  try {
    const hash = createHash("sha256");
    const diffs = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--"], signal);
    const staged = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--cached", "--"], signal);
    const head = await git(root, ["rev-parse", "--verify", "HEAD"], signal).catch(() => "unborn");
    hash.update(JSON.stringify([head, diffs, staged]));
    const names = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal))
      .split("\0").filter(Boolean).sort();
    if (names.length > 2000) throw new Error("未跟踪文件过多");
    let bytes = 0;
    for (const name of names) {
      const file = join(root, name);
      const stat = await lstat(file);
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new Error("未跟踪文件过大");
      hash.update(JSON.stringify([name, stat.mode]));
      if (stat.isSymbolicLink()) hash.update(await readlink(file));
      else if (stat.isFile()) hash.update(await readFile(file));
      else throw new Error("无法读取非普通文件");
    }
    return { kind: "git", digest: hash.digest("hex") };
  } catch {
    return { kind: "error", reason: "工作区快照失败或超过限制（2000 个未跟踪文件、16 MiB）；未判定为通过。" };
  }
}
