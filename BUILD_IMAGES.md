# TokScope Image Build Guide

## Registry

**Current:** `ghcr.io/ognodefather`
**Legacy:** `ghcr.io/neonechozero` (deprecated)

## Build Commands (Must run from repository root)

All build commands MUST be run from `/home/zero/teleport-tokscope/` (repository root).

### Browser Manager Image

```bash
cd /home/zero/teleport-tokscope
docker build -t ghcr.io/ognodefather/tokscope-browser-manager:v054 \
  -f tokscope-enclave/Dockerfile.browser-manager .
docker push ghcr.io/ognodefather/tokscope-browser-manager:v054
```

### Enclave API Image

```bash
cd /home/zero/teleport-tokscope
docker build -t ghcr.io/ognodefather/tokscope-enclave-api:v054 \
  -f tokscope-enclave/Dockerfile.api .
docker push ghcr.io/ognodefather/tokscope-enclave-api:v054
```

### Browser Image (TCB)

```bash
cd /home/zero/teleport-tokscope
docker build -t ghcr.io/ognodefather/tokscope-browser:v054 \
  -f tokscope-enclave/Dockerfile.browser .
docker push ghcr.io/ognodefather/tokscope-browser:v054
```

## Version Tracking

Version tag matches compose file: `phala-compose-v054.yml` → `:v054`

Update compose file after building new images:

```yaml
tokscope-enclave:
  image: ghcr.io/ognodefather/tokscope-enclave-api:v054

browser-manager:
  image: ghcr.io/ognodefather/tokscope-browser-manager:v054
  environment:
    - TCB_BROWSER_IMAGE=ghcr.io/ognodefather/tokscope-browser:v054
```

## Common Mistakes

❌ **WRONG:** Building from subdirectory
```bash
cd /home/zero/teleport-tokscope/tokscope-enclave
docker build -f Dockerfile.browser-manager .  # FAILS
```

✅ **CORRECT:** Building from repository root
```bash
cd /home/zero/teleport-tokscope
docker build -f tokscope-enclave/Dockerfile.browser-manager .  # WORKS
```

## Why Build from Root?

The Dockerfiles use paths like:
- `COPY tokscope-enclave/package.json`
- `COPY lib/`

These paths are relative to the build context (repository root), not the Dockerfile location.
