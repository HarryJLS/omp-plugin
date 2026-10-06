import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { snapshot } from "../src/workspace.ts";

test("Git 快照捕获已脏文件的再次修改、未跟踪内容与暂存变化", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  try {
    git("init", "-q");
    await writeFile(join(cwd, "source.txt"), "before");
    git("add", "source.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    await writeFile(join(cwd, "source.txt"), "dirty one");
    const first = await snapshot(cwd);
    await writeFile(join(cwd, "source.txt"), "dirty two");
    const second = await snapshot(cwd);
    assert.equal(first.kind, "git");
    assert.notDeepEqual(first, second);
    git("add", "source.txt");
    const staged = await snapshot(cwd);
    assert.notDeepEqual(second, staged);
    await writeFile(join(cwd, "new.txt"), "one");
    const untracked = await snapshot(cwd);
    await writeFile(join(cwd, "new.txt"), "two");
    assert.notDeepEqual(untracked, await snapshot(cwd));
    const same = await snapshot(cwd);
    assert.deepEqual(same, await snapshot(cwd));
    assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "dirty two");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("未提交过的仓库可检测新文件，不跟随符号链接读取仓库外内容", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-unborn-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const empty = await snapshot(cwd);
    assert.equal(empty.kind, "git");
    await symlink("/nonexistent/private-file", join(cwd, "link"));
    const withLink = await snapshot(cwd);
    assert.equal(withLink.kind, "git");
    assert.notDeepEqual(empty, withLink);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("非 Git 目录和快照失败区分处理", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-nogit-"));
  try {
    assert.deepEqual(await snapshot(cwd), { kind: "no-git" });
    const controller = new AbortController();
    controller.abort();
    assert.equal((await snapshot(cwd, controller.signal)).kind, "error");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("配置允许省略字段，错误配置不会静默变成开启", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-config-"));
  try {
    assert.equal((await loadConfig(cwd)).enabled, true);
    await mkdir(join(cwd, ".pi"));
    const path = join(cwd, ".pi", "auto-verify.json");
    await writeFile(path, '{"requireE2E":true,"maxRounds":2}');
    assert.equal((await loadConfig(cwd)).requireE2E, true);
    await writeFile(path, '{"maxRounds":0}');
    await assert.rejects(loadConfig(cwd));
    await writeFile(path, '{"enabld":false}');
    await assert.rejects(loadConfig(cwd));
    await writeFile(path, '{"enabled":false}');
    assert.equal((await loadConfig(cwd)).enabled, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
