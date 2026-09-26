#!/usr/bin/env bash
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
dependencies = data.get("dependencies") or {}
dependencies[name] = f"file:./packs/{pathlib.Path(tarball).name}"
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
(omp / "bun.lock").unlink(missing_ok=True)
PY

omp plugin doctor
