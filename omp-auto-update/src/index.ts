/**
 * Background omp updater.
 *
 * `omp` already checks the release channel from `startup.checkUpdate` on every
 * startup and prints an "Update Available — run: omp update" banner when the
 * registry advertises a newer version. This extension reuses that exact
 * decision — the same setting, the same `update.channel`, the same
 * `getLatestRelease` the startup check calls, and the same
 * `Bun.semver.order` comparison — and, when it says an update is available,
 * runs `proxyon` + `omp update` in a detached login shell so the user never
 * has to. A newer build only takes effect on the next omp start; the running
 * session keeps its own version.
 *
 * Only the main session runs the check (subagent sessions are skipped), and it
 * runs ~1.5s after `session_start` so it never delays the first frame. If that
 * check itself fails — no proxy in this process, registry hiccup — the decision
 * is handed to `omp update` inside the proxied shell, which re-checks and
 * no-ops when nothing is newer. The detached shell owns the actual update: it
 * takes a directory lock so two concurrent omp sessions cannot update at once,
 * and records an attempt stamp so a failing install is retried at most once per
 * day instead of on every session.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import { getLatestRelease } from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgStartupCheckUpdate, cfgUpdateChannel } from "@oh-my-pi/pi-coding-agent/modes/settings";

/** Mirrors the startup check's own timeout so a slow registry cannot wedge us. */
const CHECK_TIMEOUT_MS = 5_000;
/** Let the startup frame paint before we spend a network round-trip. */
const START_DELAY_MS = 1_500;
/** Minimum spacing between install attempts, in seconds. */
const ATTEMPT_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Runs in a detached interactive zsh: `proxyon` is an alias/function from the
 * user's rc files, so only a login-and-interactive shell can resolve it.
 */
const UPDATE_COMMAND = String.raw`
mkdir -p "$HOME/.omp/logs"
exec >>"$HOME/.omp/logs/auto-update.log" 2>&1
state_dir="$HOME/.omp/cache/omp-auto-update"
mkdir -p "$state_dir"
lock_dir="$state_dir/run.lock"
stamp="$state_dir/last-attempt"

if ! mkdir "$lock_dir" 2>/dev/null; then
  owner=0
  if [ -r "$lock_dir/owner" ]; then
    read -r owner < "$lock_dir/owner" || owner=0
  fi
  case "$owner" in
    ''|*[!0-9]*) owner=0 ;;
  esac
  if [ "$owner" -gt 0 ] && kill -0 "$owner" 2>/dev/null; then
    exit 0
  fi
  rm -f "$lock_dir/owner"
  rmdir "$lock_dir" 2>/dev/null || exit 0
  mkdir "$lock_dir" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$lock_dir/owner"
trap 'rm -f "$lock_dir/owner"; rmdir "$lock_dir" 2>/dev/null || true' EXIT HUP INT TERM

now=$(date +%s)
last=0
if [ -r "$stamp" ]; then
  read -r last < "$stamp" || last=0
fi
case "$last" in
  ''|*[!0-9]*) last=0 ;;
esac
if [ $((now - last)) -lt ${ATTEMPT_INTERVAL_SECONDS} ]; then
  printf 'skipped: last attempt was %ss ago\n' "$((now - last))"
  exit 0
fi
printf '%s\n' "$now" > "$stamp.tmp.$$" && mv "$stamp.tmp.$$" "$stamp"

if whence -w proxyon >/dev/null 2>&1; then
  proxyon
elif [ -n "$PI_PROXY$http_proxy$HTTP_PROXY$https_proxy$HTTPS_PROXY$all_proxy$ALL_PROXY" ]; then
  printf 'proxyon undefined; using the proxy already present in the environment\n'
else
  printf 'warning: proxyon undefined and no proxy env set; omp update runs unproxied and may time out\n'
fi
omp update
`;

function logLine(message: string): void {
	const logDir = join(homedir(), ".omp", "logs");
	mkdirSync(logDir, { recursive: true });
	const fd = openSync(join(logDir, "auto-update.log"), "a");
	try {
		writeSync(fd, `${new Date().toISOString()} ${message}\n`);
	} finally {
		closeSync(fd);
	}
}

/**
 * Start the updater shell in its own session, with no inherited descriptors:
 * the script redirects its own output to the log, so the parent holds nothing
 * open and nothing is printed into the running session.
 */
function spawnUpdater(reason: string): void {
	logLine(reason);

	const child = spawn("/bin/zsh", ["-ic", UPDATE_COMMAND], { detached: true, stdio: "ignore" });
	child.once("error", error => logLine(`failed to start updater: ${error.message}`));
	child.unref();
}

async function checkAndUpdate(): Promise<void> {
	if (!cfgStartupCheckUpdate.get(settings)) {
		logLine("startup.checkUpdate is off; not checking");
		return;
	}

	const channel = cfgUpdateChannel.get(settings);
	try {
		const release = await getLatestRelease({ timeoutMs: CHECK_TIMEOUT_MS, channel });
		if (Bun.semver.order(release.version, VERSION) <= 0) {
			logLine(`up to date (${VERSION}, ${channel})`);
			return;
		}
		spawnUpdater(`new release ${release.version} (running ${VERSION}); running proxyon + omp update`);
	} catch (error) {
		// This check shares omp's own in-process network path, so a proxy gap or a
		// registry hiccup surfaces here rather than as a banner. Hand the decision
		// to `omp update` inside the proxied shell: it re-checks on its own and
		// no-ops when nothing is newer.
		const detail = error instanceof Error ? error.message : String(error);
		spawnUpdater(`version check failed (${detail}); falling back to proxyon + omp update`);
	}
}

export default function autoUpdate(pi: ExtensionAPI): void {
	let scheduled = false;

	pi.on("session_start", (_event, ctx) => {
		if (scheduled || ctx.agent.kind !== "main") return;
		scheduled = true;
		// Written from the handler, so the log doubles as proof that the extension
		// was discovered and reached `session_start` in this process.
		logLine(`session started (omp ${VERSION}, pid ${process.pid}); checking in ${START_DELAY_MS}ms`);
		ctx.setTimeout(() => {
			void checkAndUpdate();
		}, START_DELAY_MS);
	});
}
