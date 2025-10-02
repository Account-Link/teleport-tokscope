#!/usr/bin/env bash
# Build tokscope-enclave with Nix - fully vendored, deterministic
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🏗️  Building with Nix (fully vendored)"

# Find nix
NIX=$(command -v nix || echo "/nix/store/i91hkfq9raq9qznwjrd59mlf1zb7nlpq-nix-2.31.2/bin/nix")

# Build API image
echo ""
echo "🔨 Building tokscope-enclave-api..."
$NIX --extra-experimental-features "nix-command flakes" build .#api-image --no-link

# Build Manager image
echo ""
echo "🔨 Building tokscope-enclave-manager..."
$NIX --extra-experimental-features "nix-command flakes" build .#manager-image --no-link

# Find the built images
API_TAR=$(ls -t /nix/store/*tokscope-enclave-api*.tar.gz | head -1)
MGR_TAR=$(ls -t /nix/store/*tokscope-enclave-manager*.tar.gz | head -1)

# Copy to current directory and extract
echo ""
echo "📦 Copying images..."
cp "$API_TAR" tokscope-enclave-api.tar.gz
cp "$MGR_TAR" tokscope-enclave-manager.tar.gz

# Extract
gunzip -f tokscope-enclave-api.tar.gz
gunzip -f tokscope-enclave-manager.tar.gz

# Calculate hashes
API_HASH=$(sha256sum tokscope-enclave-api.tar | awk '{print $1}')
MGR_HASH=$(sha256sum tokscope-enclave-manager.tar | awk '{print $1}')

echo ""
echo "✅ API hash: $API_HASH"
echo "✅ Manager hash: $MGR_HASH"

# Save manifest
cat > build-manifest-nix.json << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_commit": "$(git rev-parse HEAD)",
  "build_method": "nix",
  "hashes": {
    "api": "$API_HASH",
    "manager": "$MGR_HASH"
  }
}
EOF

echo ""
echo "🎉 SUCCESS - Nix builds complete (fully vendored)"
echo "📋 Manifest: build-manifest-nix.json"
echo ""
echo "📦 Images:"
echo "  - tokscope-enclave-api.tar"
echo "  - tokscope-enclave-manager.tar"