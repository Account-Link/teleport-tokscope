#!/usr/bin/env bash
# Deterministic build for tokscope-enclave
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🏗️  Simplified Deterministic Build"

# Use git commit as SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct)
echo "📅 SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH ($(date -d @$SOURCE_DATE_EPOCH))"

# Use simple snapshot date (no probing needed with good defaults)
DEBIAN_SNAPSHOT="20240330T000000Z"
echo "📦 DEBIAN_SNAPSHOT: $DEBIAN_SNAPSHOT"

BUILD_ARGS="--build-arg SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH --build-arg DEBIAN_SNAPSHOT=$DEBIAN_SNAPSHOT"

# Build API
echo ""
echo "🔨 Building tokscope-enclave-api..."
time docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.api \
  --output type=docker,dest=tokscope-enclave-api.tar,rewrite-timestamp=true \
  .

API_HASH=$(sha256sum tokscope-enclave-api.tar | awk '{print $1}')
echo "✅ API hash: $API_HASH"

# Build Manager
echo ""
echo "🔨 Building tokscope-browser-manager..."
time docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.browser-manager \
  --output type=docker,dest=tokscope-browser-manager.tar,rewrite-timestamp=true \
  .

MGR_HASH=$(sha256sum tokscope-browser-manager.tar | awk '{print $1}')
echo "✅ Manager hash: $MGR_HASH"

# Build Browser
echo ""
echo "🔨 Building tokscope-browser..."
time docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.browser \
  --output type=docker,dest=tokscope-browser.tar,rewrite-timestamp=true \
  .

BROWSER_HASH=$(sha256sum tokscope-browser.tar | awk '{print $1}')
echo "✅ Browser hash: $BROWSER_HASH"

# Verify determinism
echo ""
echo "🔍 Verifying determinism..."
docker builder prune -af >/dev/null 2>&1

echo "  Rebuilding API..."
docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.api \
  --output type=docker,dest=tokscope-enclave-api-verify.tar,rewrite-timestamp=true \
  . >/dev/null 2>&1

VERIFY_API_HASH=$(sha256sum tokscope-enclave-api-verify.tar | awk '{print $1}')

if [[ "$API_HASH" == "$VERIFY_API_HASH" ]]; then
  echo "  ✅ API is deterministic"
else
  echo "  ❌ API is NOT deterministic"
  exit 1
fi

echo "  Rebuilding Manager..."
docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.browser-manager \
  --output type=docker,dest=tokscope-browser-manager-verify.tar,rewrite-timestamp=true \
  . >/dev/null 2>&1

VERIFY_MGR_HASH=$(sha256sum tokscope-browser-manager-verify.tar | awk '{print $1}')

if [[ "$MGR_HASH" == "$VERIFY_MGR_HASH" ]]; then
  echo "  ✅ Manager is deterministic"
else
  echo "  ❌ Manager is NOT deterministic"
  exit 1
fi

echo "  Rebuilding Browser..."
docker buildx build \
  $BUILD_ARGS \
  -f tokscope-enclave/Dockerfile.browser \
  --output type=docker,dest=tokscope-browser-verify.tar,rewrite-timestamp=true \
  . >/dev/null 2>&1

VERIFY_BROWSER_HASH=$(sha256sum tokscope-browser-verify.tar | awk '{print $1}')

if [[ "$BROWSER_HASH" == "$VERIFY_BROWSER_HASH" ]]; then
  echo "  ✅ Browser is deterministic"
else
  echo "  ❌ Browser is NOT deterministic"
  exit 1
fi

# Cleanup verify artifacts
rm -f tokscope-enclave-api-verify.tar tokscope-browser-manager-verify.tar tokscope-browser-verify.tar

# Save manifest
cat > build-manifest.json << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_commit": "$(git rev-parse HEAD)",
  "source_date_epoch": "$SOURCE_DATE_EPOCH",
  "debian_snapshot": "$DEBIAN_SNAPSHOT",
  "hashes": {
    "api": "$API_HASH",
    "manager": "$MGR_HASH",
    "browser": "$BROWSER_HASH"
  }
}
EOF

echo ""
echo "🎉 SUCCESS - All three builds are deterministic"
echo "📋 Manifest: build-manifest.json"
echo ""

# Load into Docker and tag for registry
echo "📦 Loading images into Docker..."
API_IMAGE=$(docker load < tokscope-enclave-api.tar | grep "Loaded image" | awk '{print $NF}')
MGR_IMAGE=$(docker load < tokscope-browser-manager.tar | grep "Loaded image" | awk '{print $NF}')
BROWSER_IMAGE=$(docker load < tokscope-browser.tar | grep "Loaded image" | awk '{print $NF}')

echo "  Loaded: $API_IMAGE"
echo "  Loaded: $MGR_IMAGE"
echo "  Loaded: $BROWSER_IMAGE"

# Tag with registry (use REGISTRY env var or default to local)
REGISTRY="${REGISTRY:-localhost:5000}"
echo ""
echo "🏷️  Tagging for registry: $REGISTRY"
docker tag $API_IMAGE $REGISTRY/tokscope-enclave-api:latest
docker tag $API_IMAGE $REGISTRY/tokscope-enclave-api:$(echo $API_HASH | cut -c1-12)
docker tag $MGR_IMAGE $REGISTRY/tokscope-browser-manager:latest
docker tag $MGR_IMAGE $REGISTRY/tokscope-browser-manager:$(echo $MGR_HASH | cut -c1-12)
docker tag $BROWSER_IMAGE $REGISTRY/tokscope-browser:latest
docker tag $BROWSER_IMAGE $REGISTRY/tokscope-browser:$(echo $BROWSER_HASH | cut -c1-12)

echo ""
echo "✅ Images tagged:"
echo "  - $REGISTRY/tokscope-enclave-api:latest"
echo "  - $REGISTRY/tokscope-enclave-api:$(echo $API_HASH | cut -c1-12)"
echo "  - $REGISTRY/tokscope-browser-manager:latest"
echo "  - $REGISTRY/tokscope-browser-manager:$(echo $MGR_HASH | cut -c1-12)"
echo "  - $REGISTRY/tokscope-browser:latest"
echo "  - $REGISTRY/tokscope-browser:$(echo $BROWSER_HASH | cut -c1-12)"
echo ""
echo "🚀 To push to DockerHub:"
echo "  REGISTRY=docker.io/username ./scripts/build-deterministic.sh"
echo "  docker push $REGISTRY/tokscope-enclave-api:latest"
echo "  docker push $REGISTRY/tokscope-browser-manager:latest"
echo "  docker push $REGISTRY/tokscope-browser:latest"