#!/bin/bash
# ============================================================================
# TokScope Image Build Script - xordi-v3-k
# ============================================================================
# Builds all images for Phala deployment with Phase 0 fixes:
#   - Fix 1: Always pre-warm containers
#   - Fix 2: Clean ALL containers on startup
#   - Fix 4: Correct referer for watch history
#
# MUST be run from repository root: /home/zero/teleport-tokscope
# ============================================================================

set -e  # Exit on error

TAG="xordi-v3-k"
REGISTRY="ghcr.io/ognodefather"

# Verify we're in the right directory
if [ ! -f "tokscope-enclave/Dockerfile.api" ]; then
    echo "ERROR: Must run from /home/zero/teleport-tokscope"
    echo "Current directory: $(pwd)"
    exit 1
fi

echo "============================================"
echo "Building TokScope images with tag: $TAG"
echo "Registry: $REGISTRY"
echo "============================================"
echo ""

# Build enclave API (has Fix 4 - referer)
echo "[1/3] Building tokscope-enclave-api:$TAG..."
docker build -t $REGISTRY/tokscope-enclave-api:$TAG \
    -f tokscope-enclave/Dockerfile.api .
echo "      Done."
echo ""

# Build browser-manager (has Fix 1, 2 - cleanup)
echo "[2/3] Building tokscope-browser-manager:$TAG..."
docker build -t $REGISTRY/tokscope-browser-manager:$TAG \
    -f tokscope-enclave/Dockerfile.browser-manager .
echo "      Done."
echo ""

# Build browser
echo "[3/3] Building tokscope-browser:$TAG..."
docker build -t $REGISTRY/tokscope-browser:$TAG \
    -f tokscope-enclave/Dockerfile.browser .
echo "      Done."
echo ""

echo "============================================"
echo "All images built successfully!"
echo "============================================"
echo ""
echo "To push to registry:"
echo ""
echo "  docker push $REGISTRY/tokscope-enclave-api:$TAG"
echo "  docker push $REGISTRY/tokscope-browser-manager:$TAG"
echo "  docker push $REGISTRY/tokscope-browser:$TAG"
echo ""
echo "Or push all at once:"
echo ""
echo "  docker push $REGISTRY/tokscope-enclave-api:$TAG && \\"
echo "  docker push $REGISTRY/tokscope-browser-manager:$TAG && \\"
echo "  docker push $REGISTRY/tokscope-browser:$TAG"
echo ""
echo "Deploy to Phala with:"
echo "  /home/zero/borgcube-playwright/phala-compose-xordi-v3-k.yml"
echo ""
