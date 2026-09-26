/**
 * Background omp updater.
 *
 * `omp update` already performs omp's own version check — the same registry,
 * the same `update.channel` setting the startup banner uses — and no-ops when
 * nothing is newer. This extension never duplicates that decision in process:
 * on `session_start` it spawns a detached login zsh that runs `omp update`
 * under the user's proxy, at most once per day. omp itself decides whether an
 * update actually happens; a newer build only takes effect on the next omp
 * start, and the running session is never touched.
 *
 * The detached shell owns everything: it takes a directory lock so concurrent
 * omp sessions cannot run it twice, stamps the last attempt so it fires at
 * most once per 24h, resolves the proxy in a ladder (`proxyon` alias →
 * existing proxy env → warning), and redirects its own output to
 * ~/.omp/logs/auto-update.log, so nothing is printed into the running session.
 *
 * Subagent sessions load no user extensions, and the module-level `scheduled`
 * flag keeps one spawn per process; it runs ~1.5s after `session_start` so it
 * never delays the first frame. The extension deliberately imports nothing
 * from omp at runtime — the `ExtensionAPI` import is type-only and erased — so
 * omp internals changing shape (three settings/check API generations already
 * broke earlier builds of this extension) can never break it again.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Let the startup frame paint before the detached shell fires. */
const START_DELAY_MS = 1_500;
/** Minimum spacing between updater runs, in seconds. */
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

export default function autoUpdate(pi: ExtensionAPI): void {
	let scheduled = false;

	pi.on("session_start", (_event, ctx) => {
		if (scheduled) return;
		scheduled = true;
		// Written from the handler, so the log doubles as proof that the extension
		// was discovered and reached `session_start` in this process.
		logLine(`session started (pid ${process.pid}); handing the version check to omp update in ${START_DELAY_MS}ms`);
		ctx.setTimeout(() => {
			spawnUpdater("spawning detached proxied shell: omp update");
		}, START_DELAY_MS);
	});
}
