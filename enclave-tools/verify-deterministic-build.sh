#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <build-manifest.json>"
  echo ""
  echo "Verifies deterministic builds using manifest reference values"
  echo ""
  echo "Example:"
  echo "  $0 tagged/tokscope-enclave-20250918-97ae1d2/build-manifest.json"
  exit 1
fi

MANIFEST="$1"
if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ Manifest file not found: $MANIFEST"
  exit 1
fi

REQ_TOOLS=(jq docker)
for t in "${REQ_TOOLS[@]}"; do command -v "$t" >/dev/null || { echo "missing $t"; exit 1; }; done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "🔍 Verifying deterministic build using manifest: $MANIFEST"
echo ""

# Parse manifest
TAG=$(jq -r '.tag' "$MANIFEST")
GIT_COMMIT=$(jq -r '.git_commit' "$MANIFEST")
SOURCE_DATE_EPOCH=$(jq -r '.build_parameters.source_date_epoch' "$MANIFEST")
DEBIAN_SNAPSHOT=$(jq -r '.build_parameters.debian_snapshot' "$MANIFEST")
EXPECTED_X=$(jq -r '.expected_hashes."tokscope-enclave"' "$MANIFEST")
EXPECTED_B=$(jq -r '.expected_hashes."browser-manager"' "$MANIFEST")

echo "📋 Manifest details:"
echo "  Tag: $TAG"
echo "  Git commit: $GIT_COMMIT"
echo "  SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH"
echo "  DEBIAN_SNAPSHOT: $DEBIAN_SNAPSHOT"
echo "  Expected tokscope-enclave: $EXPECTED_X"
echo "  Expected browser-manager: $EXPECTED_B"
echo ""

# Create temporary build directory
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "[verify] Creating temporary build environment"
echo "  Temp directory: $TEMP_DIR"

# Clone the current repository to temp directory
git clone . "$TEMP_DIR/build" >/dev/null 2>&1
cd "$TEMP_DIR/build"

# Checkout the required commit
echo "[verify] Checking out commit: $GIT_COMMIT"
if ! git checkout "$GIT_COMMIT" >/dev/null 2>&1; then
  echo "❌ Failed to checkout git commit $GIT_COMMIT"
  exit 1
fi

CURRENT_COMMIT=$(git rev-parse HEAD)
echo "✅ Using commit: $CURRENT_COMMIT"

# Define build arguments shortcut
BUILD_ARGS="--build-arg SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH --build-arg DEBIAN_SNAPSHOT=$DEBIAN_SNAPSHOT"

# Clear Docker build cache for clean verification
echo "[verify] Clearing Docker build cache"
docker builder prune -af >/dev/null

# Rebuild with identical parameters
echo "[verify] Rebuilding with identical parameters"

echo "  - Building tokscope-enclave"
docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.api \
  --output type=oci,dest="$ROOT/verify-tokscope-enclave.tar",rewrite-timestamp=true \
  .

echo "  - Building browser-manager"
docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.browser-manager \
  --output type=oci,dest="$ROOT/verify-browser-manager.tar",rewrite-timestamp=true \
  .

# Return to original directory for hash comparison
cd "$ROOT"

# Compare hashes
ACTUAL_X=$(sha256sum verify-tokscope-enclave.tar | awk '{print $1}')
ACTUAL_B=$(sha256sum verify-browser-manager.tar | awk '{print $1}')

echo ""
echo "=========================================="
echo "VERIFICATION RESULTS"
echo "=========================================="
echo "tokscope-enclave:"
echo "  Expected: $EXPECTED_X"
echo "  Actual:   $ACTUAL_X"
if [[ "$ACTUAL_X" == "$EXPECTED_X" ]]; then
  echo "  ✅ VERIFIED"
  X_VERIFIED=true
else
  echo "  ❌ VERIFICATION FAILED"
  X_VERIFIED=false
fi

echo ""
echo "browser-manager:"
echo "  Expected: $EXPECTED_B"
echo "  Actual:   $ACTUAL_B"
if [[ "$ACTUAL_B" == "$EXPECTED_B" ]]; then
  echo "  ✅ VERIFIED"
  B_VERIFIED=true
else
  echo "  ❌ VERIFICATION FAILED"
  B_VERIFIED=false
fi

echo ""
echo "=========================================="

# Final result
if [[ "$X_VERIFIED" == "true" && "$B_VERIFIED" == "true" ]]; then
  echo "🎉 ALL BUILDS VERIFIED DETERMINISTIC"
  echo ""
  echo "The builds reproduce identical results as specified in the manifest."
  echo "This confirms the build process is deterministic and secure."

  # Clean up verification files
  rm -f verify-tokscope-enclave.tar verify-browser-manager.tar
  exit 0
else
  echo "💥 VERIFICATION FAILED"
  echo ""
  echo "One or more builds do not match the expected hashes."
  echo "This indicates the build process is not deterministic or"
  echo "the build environment differs from the original."

  # Keep verification files for debugging
  echo ""
  echo "Verification files kept for debugging:"
  echo "  verify-tokscope-enclave.tar"
  echo "  verify-browser-manager.tar"
  exit 1
fi