# Tests

Quick test commands for the Xordi automation system.

## Main Test Suites

### Development Tests
```bash
npm run test-dev
```
Tests all sampling methods (API, browser, web) in dev mode.

**Requires:** `npm run dev` (development containers)

### Enclave Tests
```bash
npm run test-enclave
```
Tests encrypted sessions and isolated sampling in production TCB environment.

**Requires:** `npm run enclave` (TCB containers)

### Syntax Check
```bash
npm run check
```
Validates all files compile correctly.

## Individual Tests

| Test | Command | Purpose |
|------|---------|---------|
| Direct API | `node tests/test-direct-api.js` | Mobile API client |
| Watch History | `node tests/test-watch-history.js` | Watch history API |
| Core Dev | `node tests/test-dev-core.js` | All dev methods |
| Enclave | `node tests/enclave/test-enclave.js` | TCB flow |

## Prerequisites

**Authentication session required:**
```bash
node workbench.js auth  # Generate new session
ls output/tiktok-auth-*.json  # Check existing
```

**Container environments:**
- Dev mode: `npm run dev`
- TCB mode: `npm run enclave`

## Troubleshooting

| Error | Fix |
|-------|-----|
| No auth session | `node workbench.js auth` |
| Container not running | `npm run dev` or `npm run enclave` |
| Network issues | Check `docker ps` and container logs |