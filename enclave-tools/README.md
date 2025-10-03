# Enclave Tools

Tools for building, verifying, and deploying reproducible enclave images. The enclave is designed to run in a [dstack](https://github.com/Phala-Network/dstack) TEE environment.

**Primary workflows:**
1. **Build verification** - Test and replicate reproducible builds
2. **Auditing** - Verify build determinism and inspect artifacts
3. **Development** - Test code that runs in the TEE environment
4. **Deployment** - Deploy to dstack TEE (optional)

## Reproducible Build Tools

### prepare-deterministic-build.sh
Prepares deterministic Docker builds with pinned dependencies and timestamps.

```bash
# Create deterministic build
./enclave-tools/prepare-deterministic-build.sh

# With custom snapshot date
SNAPSHOT_DATE="20240915T000000Z" ./enclave-tools/prepare-deterministic-build.sh
```

**Output artifacts:**
- `tokscope-enclave-api.tar` - API server image
- `tokscope-enclave-manager.tar` - Browser orchestrator image
- `xordi-browser.tar` - Chromium browser image
- `build-manifest.json` - SHA256 hashes for verification

**What it does:**
- Pins Debian packages to snapshot.debian.org
- Sets SOURCE_DATE_EPOCH for reproducibility
- Uses BuildKit with deterministic timestamps
- Generates manifest with image hashes

### verify-deterministic-build.sh
Verifies that two builds produce identical images.

```bash
# Build twice and verify
./enclave-tools/prepare-deterministic-build.sh
mv build-manifest.json build-manifest-1.json

./enclave-tools/prepare-deterministic-build.sh
mv build-manifest.json build-manifest-2.json

./enclave-tools/verify-deterministic-build.sh build-manifest-1.json build-manifest-2.json
```

**Verification checks:**
- Image SHA256 hashes match
- Layer counts match
- Metadata is identical

### compare-layer-contents.sh
Deep comparison of Docker image layers to diagnose non-determinism.

```bash
./enclave-tools/compare-layer-contents.sh tokscope-enclave-api:build1 tokscope-enclave-api:build2
```

**What it compares:**
- File timestamps
- File permissions
- File contents
- Directory structure
- Package versions

### extract-and-compare.sh
Extracts and compares two image tarballs.

```bash
./enclave-tools/extract-and-compare.sh tokscope-enclave-api-1.tar tokscope-enclave-api-2.tar
```

### probe-snapshot.sh
Tests availability of Debian snapshot archives.

```bash
./enclave-tools/probe-snapshot.sh 20240915T000000Z
```

**Use cases:**
- Verify snapshot date is available
- Test snapshot mirror connectivity
- Debug snapshot.debian.org issues

## Auditing Workflow

**Goal:** Independently verify that published enclave images match the source code.

### 1. Clone and verify source
```bash
git clone https://github.com/user/xordi-automation-devenv
cd xordi-automation-devenv
git checkout v1.0.0  # or specific commit
```

### 2. Build locally
```bash
npm install
npm run build
./enclave-tools/prepare-deterministic-build.sh
```

### 3. Compare with published images
```bash
# Pull published images
docker pull registry.example.com/tokscope-enclave-api:v1.0.0
docker save registry.example.com/tokscope-enclave-api:v1.0.0 -o published-api.tar

# Compare hashes
sha256sum published-api.tar
sha256sum tokscope-enclave-api.tar

# Deep comparison if needed
./enclave-tools/compare-layer-contents.sh \
  registry.example.com/tokscope-enclave-api:v1.0.0 \
  tokscope-enclave-api:latest
```

### 4. Verify attestation claims
See [ENCLAVE.md](../ENCLAVE.md) for remote attestation verification.

## Development Testing

Test enclave code locally before deploying:

```bash
# Start local enclave environment
docker compose -f docker-compose-audit.yml up --build

# Run enclave tests
npm run test:enclave

# Test with dashboard
node enclave-examples/dashboard.js
# Access at http://localhost:4000
```

## Utility Scripts

### get_compose_hash.py
Generates reproducible hash from docker-compose configuration.

```bash
python enclave-tools/get_compose_hash.py docker-compose-audit.yml
```

**Use case:** Version tracking for compose configurations.

## Dstack TEE Deployment

The enclave is designed to run in [dstack](https://github.com/Phala-Network/dstack), an open-source TEE orchestration platform. Dstack provides:
- Remote attestation for container workloads
- Confidential VM (CVM) isolation
- Distributed deployment across TEE hardware

**Note:** Phala Cloud is one provider that runs dstack infrastructure. These tools work with any dstack deployment.

### Prerequisites

1. **Pre-built images** - Dstack cannot build from Dockerfiles:
   ```bash
   # Build and tag
   ./enclave-tools/prepare-deterministic-build.sh
   docker tag tokscope-enclave-api:latest registry.example.com/tokscope-enclave-api:v1.0.0

   # Push to registry
   docker push registry.example.com/tokscope-enclave-api:v1.0.0
   ```

2. **Environment variables** - Create `.env`:
   ```bash
   # For Phala Cloud deployments
   PHALA_CLOUD_API_KEY=phak_...
   RPC_URL=https://base.llamarpc.com
   PRIVATEKEY=0x...
   ```

### Deployment Scripts

#### launch-dstack.js
Deploy compose configuration to dstack.

```bash
# Basic deployment
./enclave-tools/launch-dstack.js docker-compose-phala-server.yml --name my-deployment

# Custom node and KMS
./enclave-tools/launch-dstack.js docker-compose-phala-server.yml \
  --name prod \
  --node-id 15 \
  --kms-id kms-prod
```

#### dstack-monitor.js
Monitor and interact with deployed CVMs.

```bash
# Test connectivity
./enclave-tools/dstack-monitor.js test <app-id> --gateway dstack-base-prod7.phala.network

# Check logs
./enclave-tools/dstack-monitor.js logs <app-id> tokscope-enclave

# Get stats
./enclave-tools/dstack-monitor.js status <app-id>
```

### Gateway URL Patterns

Dstack exposes services via gateway URLs:

- **Node info**: `https://<app-id>-8090.<gateway>/`
- **API services**: `https://<instance-id>-<port>.<gateway>/`

**Example:**
```bash
# Health check (replace with your instance ID and gateway)
curl https://fdde6541e7d2da83f02959d6c2d26605ae5ebf7b-3000.dstack-base-prod7.phala.network/health
```

See `enclave-tools/dstack-interaction-guide.md` for complete gateway documentation.

### Deployment Configuration

**docker-compose-phala-server.yml** - Production-ready compose file for dstack deployment.

Key differences from local deployment:
- Uses pre-built images (no `build:` sections)
- Browser manager includes HTTP server to prevent exit
- Image references include registry paths

**Example:**
```yaml
services:
  tokscope-enclave-api:
    image: registry.example.com/tokscope-enclave-api:v1.0.0
    # No build: section - must be pre-built
```

### Troubleshooting Dstack Deployments

**Container exits immediately:**
- Missing HTTP server or incorrect entry point
- Use docker-compose-phala-server.yml with fixed browser-manager

**SSL connection issues:**
- CVM still starting (wait 1-2 minutes)
- Wrong gateway domain (check base vs eth)

**404 on API endpoints:**
- Using App ID instead of Instance ID
- Use Instance ID for port mappings, App ID for node info

## File Reference

### Build & Verification
- `prepare-deterministic-build.sh` - Create reproducible builds
- `verify-deterministic-build.sh` - Verify build determinism
- `compare-layer-contents.sh` - Deep layer comparison
- `extract-and-compare.sh` - Tarball comparison
- `probe-snapshot.sh` - Test snapshot availability
- `get_compose_hash.py` - Compose configuration hashing

### Dstack Deployment
- `launch-dstack.js` - Deploy to dstack
- `dstack-monitor.js` - Monitor deployments
- `docker-compose-phala-server.yml` - Dstack compose config
- `dstack-interaction-guide.md` - Gateway URL documentation

## See Also

- [ENCLAVE.md](../ENCLAVE.md) - Complete enclave documentation
- [argument.md](../argument.md) - TCB verification framework
- [notes/reproducible-builds.md](../notes/reproducible-builds.md) - Build implementation details
