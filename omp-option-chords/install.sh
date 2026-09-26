#!/usr/bin/env bash
# Pack this plugin and install it into omp as a real package copy at
# `~/.omp/plugins/node_modules/<name>` — no symlink back to this checkout.
#
# Needed because none of omp's own routes produce a copy from a local checkout:
# `omp plugin install <dir>` always symlinks, and `omp plugin install <tarball>`
# is rejected ("Invalid package name") since a leading `/` or `file:` is
# classified as a package name rather than a source. So this mirrors what omp's
# npm-plugin installer leaves behind — a package manifest dependency, the
# unpacked package in node_modules, and the runtime lock entry.
#
# The tarball is unpacked with tar instead of `bun install` on purpose: bun keys
# its file: dependency cache by path, so repacking at the same version would
# silently reinstall the stale extraction.
#
# Re-run after editing src/: the installed copy is frozen at pack time.
# Usage: ./install.sh
set -euo pipefail

plugin_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' "$plugin_dir/package.json" | head -1)"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$plugin_dir/package.json" | head -1)"
: "${name:?package.json is missing a name}"
: "${version:?package.json is missing a version}"

omp_dir="${OMP_PLUGINS_DIR:-$HOME/.omp/plugins}"
packs_dir="$omp_dir/packs"

mkdir -p "$packs_dir"
rm -f "$packs_dir/$name"-*.tgz
(cd "$plugin_dir" && npm pack --pack-destination "$packs_dir" >/dev/null)

python3 - "$packs_dir/$name-$version.tgz" "$omp_dir" "$name" "$version" <<'PY'
import json, pathlib, shutil, sys, tarfile

tarball, omp_dir, name, version = sys.argv[1:5]
omp = pathlib.Path(omp_dir)
node_modules = omp / "node_modules"

stage = node_modules / f".{name}.unpacking"
shutil.rmtree(stage, ignore_errors=True)
stage.mkdir(parents=True)
with tarfile.open(tarball) as archive:
    archive.extractall(stage)
shutil.rmtree(node_modules / name, ignore_errors=True)
(stage / "package").rename(node_modules / name)
shutil.rmtree(stage, ignore_errors=True)

manifest = omp / "package.json"
data = json.loads(manifest.read_text()) if manifest.exists() else {}
data["name"] = data.get("name", "omp-plugins")
data["private"] = True
dependencies = {
    dependency: spec
    for dependency, spec in (data.get("dependencies") or {}).items()
    if not (dependency == name and spec.startswith("file:./packs/"))
}
dependencies[name] = f"file:./packs/{tarball.split('/')[-1]}"
data["dependencies"] = dependencies
manifest.write_text(json.dumps(data, indent=2) + "\n")

lock = omp / "omp-plugins.lock.json"
state = json.loads(lock.read_text()) if lock.exists() else {}
entry = state.setdefault("plugins", {}).setdefault(name, {})
entry |= {
    "version": version,
    "enabledFeatures": entry.get("enabledFeatures"),
    "enabled": entry.get("enabled", True),
}
state.setdefault("settings", {})
lock.write_text(json.dumps(state, indent=2) + "\n")

# Unpacking bypasses bun, so its lockfile would describe an install that no
# longer matches this directory.
(omp / "bun.lock").unlink(missing_ok=True)
PY

omp plugin doctor
