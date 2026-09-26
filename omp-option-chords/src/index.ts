/**
 * Restore omp's Alt chords in terminals that compose Option+key into text.
 *
 * Warp (and macOS Terminal.app, and iTerm2 with "Option as Meta" off) never send
 * an `Alt+P` escape sequence: the terminal applies the macOS layout's Option
 * layer first, so `Option+P` arrives as the single character `π`, `Option+M` as
 * `µ`, and so on. omp binds `alt+p` / `alt+m` / `alt+shift+p` / … as editor
 * action chords, so those composed characters fall through to plain text entry
 * and the shortcut looks "swallowed".
 *
 * This extension listens to raw terminal input, which the TUI dispatches to
 * extensions *before* the focused editor, and rewrites such a composed character
 * back into the escape sequence the terminal would have sent with Meta enabled
 * (`ESC p` for `alt+p`, `ESC P` for `alt+shift+p`). The editor then matches the
 * chord through its normal keybinding path, so user remaps keep working: a
 * rewrite is applied only while the chord it stands for is still bound to an app
 * action, and an unbound chord keeps typing the character.
 *
 * Only single-character keystrokes are considered. Pastes and escape sequences
 * arrive as chunks carrying control bytes and are never rewritten.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getKeybindings } from "@oh-my-pi/pi-tui";

/**
 * macOS (US layout) Option-layer output → the chord that produces the same key
 * press with "Option as Meta" enabled. Mirrors omp's default Alt bindings
 * (`KEYBINDINGS` in pi-tui's `app-keybindings`).
 */
const COMPOSED_CHORDS: Record<string, string> = {
	"π": "alt+p", // Option+P       — app.model.selectTemporary
	"∏": "alt+shift+p", // Option+Shift+P — app.plan.toggle
	"µ": "alt+m", // Option+M       — app.model.select
	"¬": "alt+l", // Option+L       — app.display.reset
	"Ò": "alt+shift+l", // Option+Shift+L — app.clipboard.copyLine
	"ç": "alt+c", // Option+C       — unbound by default
	"Ç": "alt+shift+c", // Option+Shift+C — app.clipboard.copyPrompt
	"å": "alt+a", // Option+A       — app.agents.hub
	"®": "alt+r", // Option+R       — app.retry
	"√": "alt+v", // Option+V       — paste chord on Windows only
	"◊": "alt+shift+v", // Option+Shift+V — app.clipboard.pasteTextRaw
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Composed character → raw escape sequence, limited to the chords the current
 * keybindings bind to some action.
 */
function resolveRewrites(): Record<string, string> {
	const bound = new Set<string>();
	for (const keys of Object.values(getKeybindings().getResolvedBindings())) {
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			bound.add(key);
		}
	}

	const rewrites: Record<string, string> = {};
	for (const [character, chord] of Object.entries(COMPOSED_CHORDS)) {
		if (!bound.has(chord)) continue;
		// `alt+p` → ESC p, `alt+shift+p` → ESC P; only single-key Alt chords can
		// be produced by the Option layer.
		const modifiers = chord.split("+");
		const key = modifiers.pop();
		if (key === undefined || key.length !== 1) continue;
		const modifierSet = new Set(modifiers);
		if (!modifierSet.has("alt") || modifierSet.has("ctrl") || modifierSet.has("super")) continue;
		rewrites[character] = `\u001b${modifierSet.has("shift") ? key.toUpperCase() : key}`;
	}
	return rewrites;
}

function rewriteInput(data: string, rewrites: Record<string, string>): string | undefined {
	if (data.length === 0 || CONTROL_CHARS.test(data)) return undefined;

	let out = "";
	let changed = false;
	for (const character of data) {
		const replacement = rewrites[character];
		if (replacement === undefined) {
			out += character;
			continue;
		}
		out += replacement;
		changed = true;
	}
	return changed ? out : undefined;
}

export default function optionChords(pi: ExtensionAPI): void {
	let rewrites: Record<string, string> | undefined;
	let unsubscribe: (() => void) | undefined;

	const register = (ctx: ExtensionContext): void => {
		// Keybindings load before the first session starts; resolve once per
		// session so edits to keybindings.yml apply from the next one.
		rewrites = undefined;
		unsubscribe?.();
		unsubscribe = ctx.ui.onTerminalInput(data => {
			const resolved = (rewrites ??= resolveRewrites());
			const replacement = rewriteInput(data, resolved);
			return replacement === undefined ? undefined : { data: replacement };
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) register(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		if (ctx.hasUI) register(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
