#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Install to a temp dir deterministically
cp tokscope-enclave/package.json tokscope-enclave/package-lock.json "$TMP/"
pushd "$TMP" >/dev/null
npm ci --omit=dev --ignore-scripts >/dev/null

echo "== Summary =="
echo "Prod packages:" $(jq '.dependencies|keys|length' package.json)
echo "Transitive prod deps:" $(npm ls --prod --json | jq '..|.dependencies? // empty | keys' | wc -l | xargs)
echo

echo "== Risk: install/postinstall scripts =="
jq -r '
  .packages | to_entries[]
  | select(.value.hasInstallScript == true)
  | .value.name + "@" + .value.version
' node_modules/.package-lock.json | sort -u

echo
echo "== Risk: native addons (binding.gyp) =="
grep -Rsl "binding.gyp" node_modules || true

echo
echo "== Deprecated packages (declared by publisher) =="
npm ls --prod --json | jq -r '
  .dependencies
  | to_entries[]
  | select(.value.deprecated != null)
  | .key + " -> " + (.value.deprecated|tostring)
' || true

echo
echo "== Audit (high+ only) =="
npm audit --omit=dev --audit-level=high || true

echo
echo "== Engines check (must support Node >=18) =="
node -e '
const pkgs = Object.keys(require("./package.json").dependencies||{});
for (const p of pkgs) {
  try {
    const e=require("./node_modules/"+p+"/package.json").engines||{};
    if (e.node && !/^(\^|>=)?1[8-9]/.test(e.node)) {
      console.log(p, "declares engines.node:", e.node);
    }
  } catch {}
}
'
popd >/dev/null