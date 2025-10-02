#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

REQ_TOOLS=(jq docker yq)
for t in "${REQ_TOOLS[@]}"; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done

DATESTAMP=$(date +"%Y%m%d")
GIT_HASH=$(git rev-parse --short HEAD)
TAG="${DATESTAMP}-${GIT_HASH}"
OUTPUT_DIR="$ROOT/tagged/tokscope-enclave-${TAG}"

echo "🏗️  Preparing deterministic build from audit baseline: tokscope-enclave-${TAG}"
echo "📁 Output directory: $OUTPUT_DIR"

# Clean and create output directory
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# ---------- 1) Start from audit baseline ----------
echo "[baseline] copying docker-compose-audit.yml as starting point"
cp docker-compose-audit.yml "$OUTPUT_DIR/docker-compose-audit-original.yml"
cp docker-compose-audit.yml "$OUTPUT_DIR/docker-compose-build.yml"

# Copy source files needed for build context
cp -r tokscope-enclave/ "$OUTPUT_DIR/"
cp -r lib/ "$OUTPUT_DIR/"

# ---------- 2) Apply deterministic build patches ----------
echo "[patch] adding build arguments for deterministic builds"

# Only patch: Add build args for deterministic builds
COMPOSE_BUILD="$OUTPUT_DIR/docker-compose-build.yml"
echo "  - Adding SOURCE_DATE_EPOCH and DEBIAN_SNAPSHOT build args"

yq eval '.services.tokscope-enclave.build.args.SOURCE_DATE_EPOCH = ""' -i "$COMPOSE_BUILD"
yq eval '.services.tokscope-enclave.build.args.DEBIAN_SNAPSHOT = ""' -i "$COMPOSE_BUILD"
yq eval '.services.browser-manager.build.args.SOURCE_DATE_EPOCH = ""' -i "$COMPOSE_BUILD"
yq eval '.services.browser-manager.build.args.DEBIAN_SNAPSHOT = ""' -i "$COMPOSE_BUILD"

# ---------- 3) Verify package pinning ----------
PKGJSON="$OUTPUT_DIR/tokscope-enclave/package.json"
LOCK="$OUTPUT_DIR/tokscope-enclave/package-lock.json"

echo "[verify] checking package.json has no version ranges"
RANGES=$(jq -r '
  [(.dependencies//{}),(.devDependencies//{})]
  | add | to_entries[]
  | select(.value|test("^[^0-9]"))
  | .key + "=" + .value' "$PKGJSON")
[[ -z "$RANGES" ]] || { echo "❌ Unpinned deps found:"; echo "$RANGES"; exit 1; }
echo "✅ All dependencies use exact versions"

# ---------- 4) Resolve build parameters ----------
echo "[resolve] determining Debian snapshot and SOURCE_DATE_EPOCH"

# Get base image creation time for snapshot calculation
BASE_IMG=$(grep -m1 -E '^FROM ' "$OUTPUT_DIR/tokscope-enclave/Dockerfile.api" | awk '{print $2}')
CREATED=$(docker image inspect "$BASE_IMG" --format '{{.Created}}')
SEED="${SNAPSHOT_DATE:-$(date -u -d "$CREATED + 3 days" +%Y-%m-%dT%H%M%SZ)}"

echo "  - Base image: $BASE_IMG (created: $CREATED)"
echo "  - Snapshot seed: $SEED"

# Find working Debian snapshot
SNAPSHOT_DATE=$(audit-tools/probe-snapshot.sh "$SEED" | awk -F= '/SNAPSHOT_DATE/{print $2}')
[[ -n "${SNAPSHOT_DATE:-}" ]] || { echo "❌ Could not determine SNAPSHOT_DATE"; exit 1; }

# Calculate SOURCE_DATE_EPOCH (max of git commit time and base image time)
git_ts=$(git -C . log -1 --pretty=%ct)
base_ts=$(date -u -d "$CREATED" +%s)
SOURCE_DATE_EPOCH=$((git_ts > base_ts ? git_ts : base_ts))

echo "✅ DEBIAN_SNAPSHOT=$SNAPSHOT_DATE"
echo "✅ SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH ($(date -d @$SOURCE_DATE_EPOCH))"

# Apply resolved values to compose file
yq eval ".services.tokscope-enclave.build.args.DEBIAN_SNAPSHOT = \"$SNAPSHOT_DATE\"" -i "$COMPOSE_BUILD"
yq eval ".services.tokscope-enclave.build.args.SOURCE_DATE_EPOCH = \"$SOURCE_DATE_EPOCH\"" -i "$COMPOSE_BUILD"
yq eval ".services.browser-manager.build.args.DEBIAN_SNAPSHOT = \"$SNAPSHOT_DATE\"" -i "$COMPOSE_BUILD"
yq eval ".services.browser-manager.build.args.SOURCE_DATE_EPOCH = \"$SOURCE_DATE_EPOCH\"" -i "$COMPOSE_BUILD"

# Define build argument shortcuts for cleaner commands
BUILD_ARGS="--build-arg SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH --build-arg DEBIAN_SNAPSHOT=$SNAPSHOT_DATE"

# ---------- 5) Generate diff report ----------
echo "[diff] documenting changes from audit baseline"

# Generate actual diff
DIFF_OUTPUT=$(diff -u "$OUTPUT_DIR/docker-compose-audit-original.yml" "$COMPOSE_BUILD" || true)

cat > "$OUTPUT_DIR/AUDIT_BASELINE_DIFF.md" << EOF
# Deterministic Build Modifications

## Source
- **Baseline**: docker-compose-audit.yml (production audit configuration)
- **Modified**: docker-compose-build.yml (deterministic build configuration)

## Build Parameters Resolved
- **DEBIAN_SNAPSHOT**: $SNAPSHOT_DATE (verified available)
- **SOURCE_DATE_EPOCH**: $SOURCE_DATE_EPOCH ($(date -d @$SOURCE_DATE_EPOCH))
- **Git commit**: $(git rev-parse HEAD)
- **Base image**: $BASE_IMG

## Changes Applied

The only modification from the audit baseline is adding build arguments for reproducible builds:

\`\`\`diff
$DIFF_OUTPUT
\`\`\`

## Verification
The resulting build should be bit-exact identical to production when:
1. Built with identical source code (git commit $(git rev-parse HEAD))
2. Using identical base images (pinned by SHA256)
3. Using identical Debian package snapshots ($SNAPSHOT_DATE)
4. Using identical timestamp normalization ($SOURCE_DATE_EPOCH)

## Audit Trail
- The diff above shows ALL changes from the production audit configuration
- Changes are minimal and only add deterministic build parameters
- No runtime configuration is modified
EOF

# ---------- 6) Perform deterministic builds ----------
echo "[build] performing deterministic OCI builds"

# Clear build cache for clean builds
docker builder prune -af >/dev/null

echo "  - Building tokscope-enclave (build 1)"
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" docker buildx build \
  $BUILD_ARGS \
  -f "$OUTPUT_DIR/tokscope-enclave/Dockerfile.api" \
  --output type=oci,dest="$OUTPUT_DIR/tokscope-enclave-build1.tar",rewrite-timestamp=true \
  "$OUTPUT_DIR"

echo "  - Building browser-manager (build 1)"
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" docker buildx build \
  $BUILD_ARGS \
  -f "$OUTPUT_DIR/tokscope-enclave/Dockerfile.browser-manager" \
  --output type=oci,dest="$OUTPUT_DIR/browser-manager-build1.tar",rewrite-timestamp=true \
  "$OUTPUT_DIR"

HASH1_X=$(sha256sum "$OUTPUT_DIR/tokscope-enclave-build1.tar" | awk '{print $1}')
HASH1_B=$(sha256sum "$OUTPUT_DIR/browser-manager-build1.tar" | awk '{print $1}')

# Second build for determinism verification
echo "  - Clearing build cache"
docker builder prune -af >/dev/null

echo "  - Building tokscope-enclave (build 2)"
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" docker buildx build \
  $BUILD_ARGS \
  -f "$OUTPUT_DIR/tokscope-enclave/Dockerfile.api" \
  --output type=oci,dest="$OUTPUT_DIR/tokscope-enclave-build2.tar",rewrite-timestamp=true \
  "$OUTPUT_DIR"

echo "  - Building browser-manager (build 2)"
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" docker buildx build \
  $BUILD_ARGS \
  -f "$OUTPUT_DIR/tokscope-enclave/Dockerfile.browser-manager" \
  --output type=oci,dest="$OUTPUT_DIR/browser-manager-build2.tar",rewrite-timestamp=true \
  "$OUTPUT_DIR"

HASH2_X=$(sha256sum "$OUTPUT_DIR/tokscope-enclave-build2.tar" | awk '{print $1}')
HASH2_B=$(sha256sum "$OUTPUT_DIR/browser-manager-build2.tar" | awk '{print $1}')

# ---------- 7) Verify determinism ----------
echo ""
echo "=========================================="
echo "DETERMINISTIC BUILD VERIFICATION"
echo "=========================================="
echo "tokscope-enclave:"
echo "  Build 1: $HASH1_X"
echo "  Build 2: $HASH2_X"
if [[ "$HASH1_X" == "$HASH2_X" ]]; then
  echo "  ✅ DETERMINISTIC"
  X_STATUS="DETERMINISTIC"
else
  echo "  ❌ NON-DETERMINISTIC"
  X_STATUS="NON-DETERMINISTIC"
fi

echo ""
echo "browser-manager:"
echo "  Build 1: $HASH1_B"
echo "  Build 2: $HASH2_B"
if [[ "$HASH1_B" == "$HASH2_B" ]]; then
  echo "  ✅ DETERMINISTIC"
  B_STATUS="DETERMINISTIC"
else
  echo "  ❌ NON-DETERMINISTIC"
  B_STATUS="NON-DETERMINISTIC"
fi

echo ""
echo "=========================================="

# ---------- 8) Generate build manifest ----------
cat > "$OUTPUT_DIR/build-manifest.json" << EOF
{
  "tag": "${TAG}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_commit": "$(git rev-parse HEAD)",
  "git_commit_short": "$(git rev-parse --short HEAD)",
  "build_parameters": {
    "source_date_epoch": "$SOURCE_DATE_EPOCH",
    "debian_snapshot": "$SNAPSHOT_DATE",
    "base_image": "$BASE_IMG"
  },
  "expected_hashes": {
    "tokscope-enclave": "$HASH1_X",
    "browser-manager": "$HASH1_B"
  },
  "verification": {
    "status": "$([[ "$X_STATUS" == "DETERMINISTIC" && "$B_STATUS" == "DETERMINISTIC" ]] && echo "DETERMINISTIC" || echo "NON-DETERMINISTIC")",
    "xordi_enclave": "$X_STATUS",
    "browser_manager": "$B_STATUS"
  }
}
EOF

# ---------- 9) Final report ----------
echo ""
if [[ "$X_STATUS" == "DETERMINISTIC" && "$B_STATUS" == "DETERMINISTIC" ]]; then
  echo "🎉 DETERMINISTIC BUILD SUCCESS"
  echo ""
  echo "Both components verified deterministic:"
  echo "  📦 tokscope-enclave: $HASH1_X"
  echo "  📦 browser-manager: $HASH1_B"
  echo ""
  echo "📋 Generated files:"
  echo "  📄 $OUTPUT_DIR/AUDIT_BASELINE_DIFF.md - Documents changes from audit baseline"
  echo "  🔧 $OUTPUT_DIR/docker-compose-build.yml - Modified compose file"
  echo "  📋 $OUTPUT_DIR/build-manifest.json - Build parameters and expected hashes"
  echo "  📦 $OUTPUT_DIR/*-build[12].tar - OCI image archives"
  echo ""
  echo "🔍 To verify independently:"
  echo "  audit-tools/verify-deterministic-build.sh $OUTPUT_DIR/build-manifest.json"
else
  echo "💥 DETERMINISTIC BUILD FAILED"
  echo "One or more components are non-deterministic"
  exit 1
fi