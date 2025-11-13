# TokScope Image Build Guide

## Build Commands (Must run from repository root)

All build commands MUST be run from `/home/zero/teleport-tokscope/` (repository root).

### Browser Manager Image

```bash
cd /home/zero/teleport-tokscope
docker build -t ghcr.io/neonechozero/tokscope-browser-manager:xordi-vXX \
  -f tokscope-enclave/Dockerfile.browser-manager .
docker push ghcr.io/neonechozero/tokscope-browser-manager:xordi-vXX
```

**Current version:** `xordi-v11`

### Enclave API Image

```bash
cd /home/zero/teleport-tokscope
docker build -t ghcr.io/neonechozero/tokscope-enclave-api:xordi-vXX \
  -f tokscope-enclave/Dockerfile.enclave .
docker push ghcr.io/neonechozero/tokscope-enclave-api:xordi-vXX
```

**Current version:** `xordi-v17`

### Browser Image (TCB)

```bash
cd /home/zero/teleport-tokscope
docker build -t ghcr.io/neonechozero/tokscope-browser:xordi-vXX \
  -f tcb-neko-chrome/Dockerfile tcb-neko-chrome/
docker push ghcr.io/neonechozero/tokscope-browser:xordi-vXX
```

**Current version:** `xordi-v10`

## Version Tracking

Update `docker-compose-phala.yml` after building new images:

```yaml
tokscope-enclave:
  image: ghcr.io/neonechozero/tokscope-enclave-api:xordi-v17

browser-manager:
  image: ghcr.io/neonechozero/tokscope-browser-manager:xordi-v11
  environment:
    - TCB_BROWSER_IMAGE=ghcr.io/neonechozero/tokscope-browser:xordi-v10
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
