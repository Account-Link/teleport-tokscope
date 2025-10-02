# Xordi Enclave - TEE-Based Remote Nooscope Service

The Xordi Enclave is a TEE (Trusted Execution Environment) reference implementation for running nooscope sampling as a trusted remote service. It provides remote attestation that user credentials are only used for legitimate purposes like sampling timelines, without exposing sensitive data to untrusted hosts.

The enclave uses a two-tier architecture that separates public orchestration components from proprietary authentication modules, enabling static analysis to prove that credentials are used only for approved endpoints and data access patterns.

## Design Principles

- **Minimal TCB.** The enclave is a trusted compute base - keep it as simple as possible. Move complexity to untrusted components (workbench, dashboard, host).
- **Private modules.** We don't distribute reverse-engineered API auth. You bring your own, load it at runtime, and we verify it via static analysis.
- **Credential protection only.** The enclave's job is protecting credentials, not formatting responses. Data transformation happens outside the TCB.

## Quick Start

```bash
# Development mode (fast iteration)
docker compose -f docker-compose-audit.yml up --build

# Start dashboard
node enclave-examples/dashboard.js
# Access at http://localhost:4000
```

## Enclave Features

### Dashboard UI

The enclave includes a web-based dashboard for managing sessions and sampling:

**Dashboard features:**
- QR code authentication for TikTok sessions
- Session management (view, delete)
- Browser container management (create, delete, view status)
- Video sampling (For You Page, Watch History)
- Activity log and real-time monitoring
- Proxy configuration per container

### Proprietary Module System

The enclave supports loading proprietary authentication modules at runtime from GitHub gists:

**Publishing modules:**
```bash
export GITHUB_TOKEN=ghp_...
node scripts/publish-module-gist.js private-modules/web-auth.js web-auth-v1
```

**Using modules:**
```bash
# Set module URLs in environment
export WEB_AUTH_MODULE_URL=https://gist.githubusercontent.com/.../web-auth-v1.json
export MOBILE_AUTH_MODULE_URL=https://gist.githubusercontent.com/.../mobile-auth-v1.json

# Modules are loaded on-demand when using module-based sampling
```

See `docs/module-system.md` for details on module format, security, and publishing.

### API Endpoints

The enclave exposes a REST API (see `docs/api-spec.md` for full specification):

**Authentication:**
- `POST /auth/start/:sessionId` - Start QR code auth
- `GET /auth/poll/:authSessionId` - Poll auth status

**Session Management:**
- `POST /load-session` - Load session data
- `GET /sessions` - List sessions

**Sampling (Browser Automation):**
- `POST /playwright/foryoupage/sample/:sessionId` - Sample For You Page
- `POST /playwright/watchhistory/sample/:sessionId` - Sample Watch History

**Sampling (Module-based API):**
- `POST /modules/foryoupage/sample/:sessionId` - Sample via API module
- `POST /modules/watchhistory/sample/:sessionId` - Sample via API module

**Container Management:**
- `POST /containers/create` - Create browser container (with optional proxy)
- `GET /containers` - List containers
- `DELETE /containers/:containerId` - Delete container

**System:**
- `GET /health` - System health and stats

**Proxy configuration:**
- Per-container (browser): Set when creating container via `/containers/create`
- Per-request (API): Include in sampling request body
- See `docs/api-spec.md` for full details

## Remote Attestation and TEEs

In the TEE environment, only the xordi enclave containers can access user credentials. The goal is to provide remote attestation that credentials are not misused - they are only used for sampling the "For You Page" and "Watch History" as intended.

Remote attestation allows third parties to verify:
1. **Code identity** - The exact enclave code running (via reproducible builds)
2. **Runtime isolation** - Credentials cannot leak to host or other containers
3. **Behavior constraints** - Static analysis proves only approved TikTok endpoints are accessed

See `logical-proof-framework.md` for the complete verification framework.

## Reproducible Builds

For production deployment and remote attestation, use deterministic builds:

### Docker approach: deterministic but not vendored

```bash
./scripts/build-deterministic.sh
```

- ✅ Deterministic builds with pinned packages
- ✅ Smaller images (api: 90MB, manager: 180MB, browser: 577MB)
- ✅ Simple tooling (just Docker + BuildKit)
- ⚠️ Requires internet (downloads from snapshot.debian.org + npm registry)

### Nix approach: deterministic and fully vendored

```bash
./scripts/build-with-nix.sh
```

- ✅ Deterministic builds with content-addressed dependencies
- ✅ Fully vendored to /nix/store (offline builds after first fetch)
- ✅ No external network dependencies after initial build
- ⚠️ Larger manager image (~380MB due to /nix/store paths)
- ⚠️ Requires Nix installed

**Note:** No code changes needed between methods. Nix is just an optional build tool for vendoring. The tokscope-enclave code is pure TypeScript/Node.js.

### Output artifacts

Deterministic builds produce:
- `tokscope-enclave-api.tar` - API server
- `tokscope-enclave-manager.tar` - Browser orchestrator
- `tokscope-browser.tar` - Chromium browser (Docker approach only)
- `build-manifest.json` - SHA256 hashes for verification

Images are automatically loaded and tagged for registry push. See `notes/reproducible-builds.md` for detailed comparison and decision guide.

### Verification tools

The `enclave-tools/` directory contains scripts for verifying reproducible builds:

```bash
# Verify build determinism
./enclave-tools/verify-deterministic-build.sh

# Compare layer contents between builds
./enclave-tools/compare-layer-contents.sh

# Extract and compare artifacts
./enclave-tools/extract-and-compare.sh
```

See `enclave-tools/README.md` for detailed verification workflow.

## Deploy to DStack

```bash
# Tag for your registry
REGISTRY=docker.io/username ./scripts/build-deterministic.sh

# Push to DockerHub
docker push docker.io/username/tokscope-enclave-api:latest
docker push docker.io/username/tokscope-enclave-manager:latest
docker push docker.io/username/tokscope-browser:latest

# Use in docker-compose-audit.yml with image: docker.io/username/tokscope-enclave-api:latest
```

For DStack-specific deployment and monitoring:

```bash
# Launch on DStack
node enclave-tools/launch-dstack.js

# Monitor deployment
node enclave-tools/dstack-monitor.js
```

See `enclave-tools/dstack-interaction-guide.md` for complete deployment instructions.

## Module System & Static Analysis

The enclave supports two sampling methods:
1. **Browser automation** (Playwright) - Navigates TikTok like a user, extracts from DOM
2. **API modules** - Calls TikTok's undocumented APIs directly (faster, lighter)

API modules require reverse-engineered authentication, which we don't distribute. You bring your own, load at runtime via HTTP/gist, and the enclave verifies safety through static analysis.

**Verification checks:**
- Only approved TikTok endpoints accessed
- Only built-in Node.js APIs used
- No unauthorized network/filesystem operations
- AST-based analysis of module code

See `logical-proof-framework.md` for the complete verification framework.

## Testing

```bash
# Start production audit environment
npm run start:audit

# Run auth and sampling tests
node tests/enclave/test-auth-and-sampling.js

# Run enclave tests (uses mock modules)
npm run test:enclave
```

**Auth and Sampling Tests** (`test-auth-and-sampling.js`):
- ✅ QR code authentication flow (displays QR as ASCII art)
- ✅ Session management and loading
- ✅ Playwright-based For You page sampling
- ✅ Health monitoring and status checks
- ✅ Deprecated endpoint handling

**Enclave Module Tests** (`npm run test:enclave`):
- ✅ HTTP module loading and validation
- ✅ AST-based security analysis
- ✅ Container isolation and networking
- ✅ Session encryption
- ✅ Dangerous module rejection

See `docs/api-spec.md` for complete API documentation.

## Architecture

The enclave consists of three container types:

1. **tokscope-enclave-api** - REST API server, handles session encryption, module validation
2. **tokscope-enclave-manager** - Browser container orchestration via Docker API
3. **tokscope-browser** - Isolated Chromium instances with CDP access

Only the API and manager containers are in the TCB. Browser containers are created/destroyed dynamically and contain no credentials.

## Development builds (fast)

For quick iteration during development:

```bash
# Build and run with docker compose (not deterministic)
docker compose -f docker-compose-audit.yml up --build
```

This builds images normally but **not deterministically** (timestamps vary). Fine for development and testing, but not suitable for remote attestation.

## Troubleshooting

**Enclave issues:** Check `docker compose -f docker-compose-audit.yml logs`
**Build issues:** Ensure TypeScript compiled: `npm run build`
**Module loading issues:** Check `docs/module-system.md` for module format requirements
**Attestation issues:** Verify build artifacts match expected hashes in `build-manifest.json`
