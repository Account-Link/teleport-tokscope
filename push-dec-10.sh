#!/bin/bash
# ============================================================================
# TokScope Image Push Script - dec-10
# ============================================================================
# Pushes all dec-10 images to ghcr.io/ognodefather
# ============================================================================

set -e

TAG="dec-10"
REGISTRY="ghcr.io/ognodefather"

echo "============================================"
echo "Pushing TokScope images with tag: $TAG"
echo "Registry: $REGISTRY"
echo "============================================"
echo ""

echo "[1/3] Pushing tokscope-enclave-api:$TAG..."
docker push $REGISTRY/tokscope-enclave-api:$TAG
echo "      Done."
echo ""

echo "[2/3] Pushing tokscope-browser-manager:$TAG..."
docker push $REGISTRY/tokscope-browser-manager:$TAG
echo "      Done."
echo ""

echo "[3/3] Pushing tokscope-browser:$TAG..."
docker push $REGISTRY/tokscope-browser:$TAG
echo "      Done."
echo ""

echo "============================================"
echo "All images pushed successfully!"
echo "============================================"
echo ""
echo "Deploy to Phala with:"
echo "  /home/zero/borgcube-playwright/phala-compose-dec-10.yml"
echo ""
