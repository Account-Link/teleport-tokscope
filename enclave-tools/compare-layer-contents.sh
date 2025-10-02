#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <layer1_hash> <layer2_hash>"
  echo "Compares the contents of two layers from image-extracts/"
  exit 1
fi

LAYER1="$1"
LAYER2="$2"

WORK_DIR="./layer-comparison"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/layer1" "$WORK_DIR/layer2"

echo "🔍 Comparing layer contents:"
echo "  Layer 1: $LAYER1"
echo "  Layer 2: $LAYER2"

# Extract the layers (they're gzipped tar files)
echo "Extracting layers..."
if [[ -f "image-extracts/original/blobs/sha256/$LAYER1" ]]; then
  gunzip -c "image-extracts/original/blobs/sha256/$LAYER1" | tar -xf - -C "$WORK_DIR/layer1" 2>/dev/null || echo "Failed to extract layer1 from original"
elif [[ -f "image-extracts/verify/blobs/sha256/$LAYER1" ]]; then
  gunzip -c "image-extracts/verify/blobs/sha256/$LAYER1" | tar -xf - -C "$WORK_DIR/layer1" 2>/dev/null || echo "Failed to extract layer1 from verify"
fi

if [[ -f "image-extracts/original/blobs/sha256/$LAYER2" ]]; then
  gunzip -c "image-extracts/original/blobs/sha256/$LAYER2" | tar -xf - -C "$WORK_DIR/layer2" 2>/dev/null || echo "Failed to extract layer2 from original"
elif [[ -f "image-extracts/verify/blobs/sha256/$LAYER2" ]]; then
  gunzip -c "image-extracts/verify/blobs/sha256/$LAYER2" | tar -xf - -C "$WORK_DIR/layer2" 2>/dev/null || echo "Failed to extract layer2 from verify"
fi

echo ""
echo "=== DIRECTORY STRUCTURE COMPARISON ==="
echo "Layer 1 contents:"
find "$WORK_DIR/layer1" -type f 2>/dev/null | sort || echo "No files in layer1"
echo ""
echo "Layer 2 contents:"
find "$WORK_DIR/layer2" -type f 2>/dev/null | sort || echo "No files in layer2"

echo ""
echo "=== FILE DIFFERENCES ==="
# Compare file lists
find "$WORK_DIR/layer1" -type f 2>/dev/null | sed "s|$WORK_DIR/layer1||" | sort > /tmp/layer1-files || touch /tmp/layer1-files
find "$WORK_DIR/layer2" -type f 2>/dev/null | sed "s|$WORK_DIR/layer2||" | sort > /tmp/layer2-files || touch /tmp/layer2-files

echo "Files only in layer1:"
comm -23 /tmp/layer1-files /tmp/layer2-files || true
echo ""
echo "Files only in layer2:"
comm -13 /tmp/layer1-files /tmp/layer2-files || true
echo ""
echo "Common files:"
comm -12 /tmp/layer1-files /tmp/layer2-files > /tmp/common-files

# For common files, check if content differs
echo "Content differences in common files:"
while IFS= read -r file; do
  if [[ -n "$file" && -f "$WORK_DIR/layer1$file" && -f "$WORK_DIR/layer2$file" ]]; then
    if ! cmp -s "$WORK_DIR/layer1$file" "$WORK_DIR/layer2$file"; then
      echo "  DIFFERENT: $file"
      # Show file details
      echo "    Layer1: $(ls -la "$WORK_DIR/layer1$file" | awk '{print $5, $6, $7, $8}')"
      echo "    Layer2: $(ls -la "$WORK_DIR/layer2$file" | awk '{print $5, $6, $7, $8}')"
    fi
  fi
done < /tmp/common-files

echo ""
echo "Extracted to $WORK_DIR for detailed inspection"