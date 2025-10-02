#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <image1.tar> <image2.tar>"
  exit 1
fi

IMG1="$1"
IMG2="$2"

# Create persistent extraction directory
EXTRACT_DIR="./image-extracts"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR/original" "$EXTRACT_DIR/verify"

echo "🔍 Extracting images to $EXTRACT_DIR"
tar -xf "$IMG1" -C "$EXTRACT_DIR/original"
tar -xf "$IMG2" -C "$EXTRACT_DIR/verify"

# Get manifest hashes
ORIG_MANIFEST=$(jq -r '.manifests[0].digest' "$EXTRACT_DIR/original/index.json" | cut -d: -f2)
VERIFY_MANIFEST=$(jq -r '.manifests[0].digest' "$EXTRACT_DIR/verify/index.json" | cut -d: -f2)

echo "Original manifest: $ORIG_MANIFEST"
echo "Verify manifest: $VERIFY_MANIFEST"

# Extract layer lists
echo ""
echo "=== LAYER COMPARISON ==="
echo "Original layers:"
jq -r '.layers[].digest' "$EXTRACT_DIR/original/blobs/sha256/$ORIG_MANIFEST"
echo ""
echo "Verification layers:"
jq -r '.layers[].digest' "$EXTRACT_DIR/verify/blobs/sha256/$VERIFY_MANIFEST"

# Find different layers
echo ""
echo "=== LAYER DIFFERENCES ==="
jq -r '.layers[].digest' "$EXTRACT_DIR/original/blobs/sha256/$ORIG_MANIFEST" | sort > /tmp/orig-layers
jq -r '.layers[].digest' "$EXTRACT_DIR/verify/blobs/sha256/$VERIFY_MANIFEST" | sort > /tmp/verify-layers

echo "Layers only in original:"
comm -23 /tmp/orig-layers /tmp/verify-layers || true
echo "Layers only in verification:"
comm -13 /tmp/orig-layers /tmp/verify-layers || true
echo "Common layers:"
comm -12 /tmp/orig-layers /tmp/verify-layers | wc -l | xargs echo

echo ""
echo "Extracted to $EXTRACT_DIR for manual inspection"