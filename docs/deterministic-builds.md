# Deterministic Builds for TCB Mode

## Overview

This document describes the deterministic build system created for tokscope-enclave to enable reliable TCB (Trusted Computing Base) auditing. Instead of relying on theoretical proofs, this approach provides cryptographic verification through reproducible builds with exact dependency pinning.

## Problem Statement

The original TCB Mode documentation attempted to provide "mathematical proof" of system constraints, but this approach had several issues:
- Complex app-compose hash generation requiring DStack SDK integration
- Fragile translation between Docker Compose and DStack concepts
- Theoretical framework that was difficult to verify practically
- No concrete way to ensure audit environment matched production

## Solution: Deterministic Build System

### Core Principles

1. **Complete Dependency Pinning**: Every component locked to exact versions
2. **Cryptographic Verification**: Image hashes provide proof of build integrity
3. **Reproducible Process**: Anyone can rebuild and verify the same artifacts
4. **Self-Contained Output**: Tagged builds include everything needed for audit

### Build Process

#### 1. Preparation Script
Location: `audit-tools/prepare-deterministic-build.sh`

The script performs these steps:
- **Start from Audit Baseline**: Copies `docker-compose-audit.yml` as the foundation
- **Apply Minimal Patches**: Only adds build arguments for reproducible builds
- **Verify Package Pinning**: Ensures all dependencies use exact versions
- **Resolve Build Parameters**: Determines SOURCE_DATE_EPOCH and Debian snapshot
- **Generate Real Diff**: Documents actual changes from audit configuration
- **Build OCI Images**: Creates deterministic builds using BuildKit timestamp rewriting
- **Verify Determinism**: Compares SHA256 hashes between two identical builds
- **Create Build Manifest**: Generates JSON with all build parameters and expected hashes

#### 2. Dependency Pinning Strategy

**Base Images:**
- `node:18-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e`
- `ghcr.io/m1k1o/neko/chromium@sha256:23472d1adf85a0e170c56326f58928bfa716c7ade0ef9d87d54af15116c8639c`

**OS Packages (Example from latest build):**
- `socat=1.7.4.4-2`
- `docker.io=20.10.24+dfsg1-1+deb12u1+b2`
- `curl=7.88.1-10+deb12u14`
- `ca-certificates=20230311+deb12u1`

**NPM Dependencies:**
- Remove `^` and `~` version ranges from package.json
- Pin to exact versions: `express: 4.18.2` instead of `^4.18.2`
- Generate package-lock.json with 224+ dependencies and SHA integrity hashes
- Provides both availability guarantee (exact versions) and integrity guarantee (cryptographic verification)
- Note: `@phala/dstack-sdk: latest` remains as-is (resolved during npm install)

#### 3. Tagged Build Output

Each build creates a clean directory: `tagged/tokscope-enclave-{datestamp}-{git-hash}/`

**Contents:**
```
tagged/tokscope-enclave-20250918-6348c4e/
├── docker-compose-audit-original.yml # Original audit configuration (baseline)
├── docker-compose-build.yml         # Modified compose with build arguments
├── AUDIT_BASELINE_DIFF.md           # Documents exact changes from audit baseline
├── build-manifest.json             # Complete build parameters and expected hashes
├── tokscope-enclave-build1.tar        # First deterministic OCI build
├── tokscope-enclave-build2.tar        # Second deterministic OCI build (verification)
├── browser-manager-build1.tar      # First browser-manager OCI build
├── browser-manager-build2.tar      # Second browser-manager OCI build (verification)
├── tokscope-enclave/                  # Source code and Dockerfiles
│   ├── package.json                # Exact version dependencies
│   ├── package-lock.json           # Full dependency tree with integrity hashes
│   ├── Dockerfile.api              # Multi-stage Dockerfile with TypeScript build
│   └── Dockerfile.browser-manager  # Multi-stage Dockerfile for browser management
└── lib/                            # Shared library code
```

### Example Build Results

From successful build `20250918-6348c4e`:

**OCI Image Hashes:**
- `tokscope-enclave`: `84514c0444b9b0a00a8a2e90001b42a8c5e637d80a98de6630e98e47c356dda6`
- `browser-manager`: `dccc69686f67f1e5121a8f90d27e6572335c4dfa13b9b231f1062fea895d9ab5`

**Build Manifest:**
```json
{
  "tag": "20250918-6348c4e",
  "git_commit": "34f3b7217746229a27b6a58900a36edd9d20212c",
  "build_parameters": {
    "source_date_epoch": "1758170149",
    "debian_snapshot": "20240915T000000Z"
  },
  "expected_hashes": {
    "tokscope-enclave": "84514c0444b9b0a00a8a2e90001b42a8c5e637d80a98de6630e98e47c356dda6",
    "browser-manager": "dccc69686f67f1e5121a8f90d27e6572335c4dfa13b9b231f1062fea895d9ab5"
  }
}
```

**Audit Baseline Diff:**
- Only adds build arguments for deterministic builds
- No runtime configuration changes
- Complete diff documented in `AUDIT_BASELINE_DIFF.md`

**Verification Process:**
1. Use separate verification tool: `audit-tools/verify-deterministic-build.sh`
2. Reads manifest and rebuilds with identical parameters
3. Compares SHA256 hashes of OCI images
4. Confirms deterministic behavior through hash matching

## TCB Audit Capabilities

The deterministic build enables concrete audit verification of these capabilities:

### Allowed Operations
- **Network Endpoints**: Only TikTok APIs (`*.tiktok.com`, `*.tiktokv.com`)
- **HTTP Methods**: GET for timeline/history, POST for like actions only
- **Data Flow**: Session cookies → HTTP headers → TikTok API (read-only)

### Prohibited Operations (Enforced by Build Constraints)
- Account settings modification
- Profile/credential changes
- Posting/upload functionality
- External service communication
- Credential extraction beyond cookie usage

### Verification Method
Instead of theoretical proof, auditors can:
1. Reproduce the exact same build using the tagged reference
2. Verify image hashes match expected values
3. Inspect pinned dependencies for unauthorized capabilities
4. Run the environment and test endpoint behavior

## Benefits Over Previous Approach

### Concrete vs. Theoretical
- **Before**: Complex logical proof framework requiring deep understanding
- **After**: Simple hash comparison and dependency inspection

### Practical Verification
- **Before**: App-compose hash generation requiring DStack SDK
- **After**: Standard Docker tools and straightforward verification scripts

### Reproducibility
- **Before**: Difficult to reproduce "audit environment"
- **After**: Anyone can rebuild identical images from tagged reference

### Developer Experience
- **Before**: Manual configuration and complex dependency management
- **After**: Single command generates complete tagged build ready for audit

## Usage Instructions

### Creating a New Deterministic Build
```bash
# From project root
./audit-tools/prepare-deterministic-build.sh

# Output will show:
# ✅ DETERMINISTIC BUILD SUCCESS
# 📦 tokscope-enclave: <hash>
# 📦 browser-manager: <hash>
# 📋 Generated files in tagged/tokscope-enclave-{tag}/
```

### Verifying an Existing Build
```bash
# Use the verification tool with manifest
./audit-tools/verify-deterministic-build.sh tagged/tokscope-enclave-{tag}/build-manifest.json

# Output shows:
# ✅ Git commit matches
# ✅ tokscope-enclave VERIFIED
# ✅ browser-manager VERIFIED
# 🎉 ALL BUILDS VERIFIED DETERMINISTIC
```

### Auditing a Tagged Build
```bash
# Navigate to tagged build
cd tagged/tokscope-enclave-{tag}/

# Review audit baseline changes
cat AUDIT_BASELINE_DIFF.md

# Inspect build manifest
cat build-manifest.json | jq .

# Review dependency constraints
cat tokscope-enclave/package-lock.json | jq '.packages | keys | length'  # Count pinned packages
cat docker-compose-build.yml  # View modified compose configuration

# Compare with original audit baseline
diff docker-compose-audit-original.yml docker-compose-build.yml
```

## Integration with TCB Mode Documentation

This deterministic build system provides the foundation for improved TCB Mode documentation:

### README Updates Needed
1. Replace theoretical "mathematical proof" language with practical verification
2. Add reference to deterministic build process
3. Include concrete hash verification examples
4. Explain audit scope through dependency constraints

### Audit Documentation Updates
1. Focus on reproducible build verification vs. impossibility proofs
2. Use image hashes as primary verification method
3. Provide step-by-step audit procedures using tagged builds
4. Document expected capabilities based on pinned dependencies

## Future Improvements

### Potential Enhancements
1. **Automated Hash Verification**: Scripts to compare production vs. audit hashes
2. **Dependency Scanning**: Automated analysis of pinned packages for security issues
3. **Multi-Architecture Support**: Deterministic builds for different CPU architectures
4. **Signed Builds**: Add cryptographic signatures to build artifacts

### Integration Opportunities
1. **CI/CD Integration**: Automatic generation of deterministic builds on releases
2. **Production Deployment**: Use tagged builds as source for production containers
3. **Audit Automation**: Automated verification of production vs. tagged build hashes

## Files Modified/Created

### New Files
- `audit-tools/prepare-deterministic-build.sh` - Main build preparation script
- `docs/deterministic-builds.md` - This documentation
- `tagged/tokscope-enclave-{tag}/` - Generated tagged build directories

### Generated Per Build
- `docker-compose-audit.yml` - Hash-constrained compose configuration (core audit artifact)
- `verify-build.sh` - Image verification script
- `tokscope-enclave/package-lock.json` - Full dependency tree with integrity hashes
- `tokscope-enclave/Dockerfile.*` - Pinned Dockerfiles with exact base images and OS packages

### Key Improvements in Current Implementation
- **True Determinism**: Docker-compose file constrains exact container images by SHA256 hash
- **Simplified Package.json**: No build metadata, clean dependency specification
- **Cryptographic Verification**: Package-lock.json provides integrity hashes for all dependencies
- **Reproducible App-Compose Hash**: Identical hash across rebuilds proves deterministic behavior

This deterministic build system provides a solid, practical foundation for TCB Mode auditing, replacing theoretical frameworks with concrete, verifiable artifacts.

## Technical Implementation Details

### Hash-Constrained Docker Compose

The key innovation is that the final `docker-compose-audit.yml` file references images by their cryptographic hashes:

```yaml
services:
  tokscope-enclave:
    image: tokscope-enclave:20250917-d5f358f@sha256:9749fed3a26656a1e9f281e9e5eb9a39b1ee5cf5749a2c9c2b29f24432fc5288
```

This approach ensures:
- **No Build Ambiguity**: The compose file doesn't build anything, it references exact pre-built images
- **Cryptographic Constraint**: The SHA256 hash cryptographically constrains which container runs
- **Registry Independence**: The hash constraint works regardless of where images are stored
- **Audit Transparency**: Auditors can verify the exact containers that will run

### Dependency Constraint Strategy

**Multi-Layer Pinning:**
1. **Base Images**: Pinned to SHA256 digests in Dockerfiles
2. **OS Packages**: Pinned to exact versions (e.g., `socat=1.7.4.4-2`)
3. **NPM Dependencies**: Complete dependency tree in package-lock.json with integrity hashes
4. **Container Images**: Final built images referenced by SHA256 in docker-compose

**Availability + Integrity Guarantees:**
- **Availability**: All dependencies pinned to exact, resolvable versions
- **Integrity**: Cryptographic verification at every layer (SHA256 hashes, NPM integrity hashes)

### App-Compose Hash Verification

The deterministic nature is proven by the app-compose hash remaining identical across rebuilds:
- Hash: `e85cdb71cb01d8c131ae0cfba2d3e9f58f6e57eb68a36b2a628ebcc93fcc7c84`
- Generated from the docker-compose-audit.yml structure
- Provides DStack-compatible verification without requiring DStack SDK

This system replaces theoretical "mathematical proof" approaches with practical, cryptographically-verifiable deterministic builds.