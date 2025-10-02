# Architecture & Dependencies

This document explains the core dependencies and how they work together to enable TikTok algorithmic transparency sampling.

## System Overview

```
┌─────────────────────┐
│  Your Code          │
│  (tokscope.js,      │
│   workbench.js,     │
│   BrowserAutomation │
│   Client)           │
└──────────┬──────────┘
           │
           │ CDP (Chrome DevTools Protocol)
           │ Port 9223
           ↓
┌─────────────────────────────┐
│  Neko Container             │
│  ┌─────────────────────┐    │
│  │ Chromium Browser    │    │
│  │ (running in Xorg)   │    │
│  └─────────────────────┘    │
│           │                 │
│           │ GStreamer       │
│           ↓                 │
│  ┌─────────────────────┐    │
│  │ WebRTC Server       │────┼──→ Port 8080
│  └─────────────────────┘    │     (viewer access)
└─────────────────────────────┘
```

## Core Dependencies

### 1. Neko (m1k1o/neko)

**What it is:** Self-hosted virtual browser that runs in Docker

**What it does:**
- Runs Chromium browser in a containerized environment
- Streams the browser view to users via WebRTC
- Allows multiple users to view and control the browser remotely

**How it works:**
1. **X Server (Xorg)** - Provides display server for Chromium to render
2. **Chromium** - The actual browser, running headless with GUI
3. **GStreamer** - Captures video/audio from the X server
4. **WebRTC** - Streams captured content to viewers over the network

**What we use it for:**
- Provides visual browser access at http://localhost:8080 (username: `neko`, password: `neko`)
- Allows you to watch automation in real-time
- Useful for debugging auth flows and sampling scripts
- Exposes Chrome DevTools Protocol (CDP) for programmatic control

**Network configuration:**
- Browser container runs at `17.100.0.3` (see docker-compose.yml)
- WebRTC viewer: port 8080
- CDP endpoint: port 9223

**Reference:** `refs/neko/` contains the full neko source code

### 2. Playwright

**What it is:** Browser automation library (similar to Puppeteer, Selenium)

**What it does:**
- Provides programmatic control of browsers
- Can navigate pages, click elements, extract data
- Intercept network requests and responses

**How we use it:**
- Connects to Neko's Chromium via CDP (Chrome DevTools Protocol)
- Automates TikTok navigation and scrolling
- Intercepts API responses to capture video data
- Manages cookies and session state

**Key class:** `BrowserAutomationClient` in `lib/browser-automation-client.ts`

**Why both Neko and Playwright?**
- Neko provides the **visual browser** (WebRTC viewer for debugging)
- Playwright provides **programmatic control** (CDP for automation)
- You can watch (via Neko) what Playwright is doing - best of both worlds

### 3. Chrome DevTools Protocol (CDP)

**What it is:** Protocol for tools to instrument, inspect, debug Chromium

**How it works:**
- Chromium listens on 127.0.0.1:9222 (localhost-only for security)
- socat proxy forwards external port 9223 → internal 127.0.0.1:9222
- Tools connect via WebSocket to send commands and receive events
- Allows full control: navigation, DOM access, network interception, etc.

**The bridge:**
```
Playwright <--CDP:9223--> socat proxy <--9222--> Chromium (127.0.0.1 only)
```

**Why the socat proxy:**
- Chromium's CDP doesn't accept external connections reliably, even without `--remote-debugging-address` restriction
- socat TCP proxy on port 9223 forwards to Chromium's 127.0.0.1:9222
- This workaround ensures reliable connections from host to container
- **TODO**: Investigate if this is Chromium version-specific and can be removed in newer versions

**Why CDP matters:**
- Enables both manual viewing (Neko WebRTC) and automation (Playwright) simultaneously
- You can debug by watching the browser while your script runs
- Session state (cookies, localStorage) persists in the browser

## How They Work Together

### Authentication Flow

1. Your code (e.g., `tokscope.js auth`) starts authentication
2. Playwright connects to Chromium via CDP at `http://localhost:9223`
3. Playwright navigates to TikTok QR login page
4. QR code is extracted and displayed to user
5. **You can watch this in real-time** by opening http://localhost:8080
6. User scans QR with TikTok app
7. Playwright detects login completion (checks for session cookies)
8. `BrowserAutomationClient.extractAuthData()` saves session

### Sampling Flow

1. Your code (e.g., `tokscope.js sample`) starts sampling
2. Playwright connects to existing Chromium session via CDP
3. Loads saved cookies into browser context
4. Navigates to TikTok For You page
5. Sets up network interception to capture API responses
6. Scrolls through feed (you can watch via Neko viewer)
7. Captures video data from intercepted `/api/recommend/item_list/` responses
8. Returns collected videos

### Development Flow (Workbench)

1. Start browser: `docker compose up -d`
2. Connect via Playwright: `node workbench.js`
3. **Debug visually:** Open http://localhost:8080 to watch
4. **Automate programmatically:** Playwright scripts run via CDP
5. Best of both worlds: visual feedback + automation

## Container Architecture

### Development Mode (docker-compose.yml)

Single browser container:
- Container name: `simple-dev-browser`
- Network: `17.100.0.3`
- Ports: 8080 (WebRTC), 9223 (CDP)
- Used by: workbench.js, tokscope.js

### Enclave Mode (docker-compose-audit.yml)

Multi-container architecture:
- **tokscope-enclave-api** - REST API server
- **tokscope-enclave-manager** - Browser container orchestration
- **tokscope-browser** - Isolated Chromium instances (dynamically created)

See `enclave.md` for complete enclave architecture.

## Why This Architecture?

**Separation of concerns:**
- Neko handles browser runtime and visualization
- Playwright handles automation logic
- CDP bridges the two

**Debugging advantage:**
- You can watch the browser while automation runs
- No need for headless vs headed mode switching
- See exactly what TikTok shows your automation

**Production ready:**
- Same browser automation code works in dev (workbench) and production (enclave)
- Visual debugging in dev, isolation in production
- Reproducible builds for TEE deployment

## Key Files

- `lib/browser-automation-client.ts` - Playwright automation wrapper
- `lib/qr-extractor.ts` - QR code extraction from pages
- `docker-compose.yml` - Development browser container
- `docker-compose-audit.yml` - Enclave containers
- `refs/neko/` - Neko source code reference

## Network Ports

| Port | Service | Access |
|------|---------|--------|
| 8080 | Neko WebRTC | Browser viewer UI |
| 9222 | CDP (internal) | Chromium's actual CDP port (127.0.0.1 only) |
| 9223 | CDP (external) | socat proxy for external access |
| 8001 | Nooscope Web | Dashboard UI |
| 3000 | Enclave API | TEE API server |
| 3001 | Browser Manager | Container orchestration |

**Note on port convention:** Standard CDP port is 9222, but we expose 9223 externally because Chromium's CDP doesn't reliably accept external connections (even without `--remote-debugging-address=127.0.0.1`). The socat proxy is a workaround - may be Chromium version-specific. Using conventional port 9222 externally would require investigating why direct external connections fail.

## Common Issues

**"Cannot connect to CDP"**
- Check browser container is running: `docker compose ps`
- Verify CDP port: `curl http://localhost:9223/json/version`

**"WebRTC won't load"**
- Check neko service is up: `docker compose logs simple-dev-browser`
- Try refreshing the page at http://localhost:8080

**"Session extraction fails"**
- Open Neko viewer to see what page TikTok actually loaded
- TikTok's DOM structure may have changed - update extraction methods in `BrowserAutomationClient.extractUserData()`

## Learn More

- Neko documentation: https://neko.m1k1o.net/
- Playwright docs: https://playwright.dev/
- CDP protocol: https://chromedevtools.github.io/devtools-protocol/

## Related Documentation

- [README.md](README.md) - Project overview and quick start
- [workbench.md](workbench.md) - Development environment guide
- [enclave.md](enclave.md) - TEE production deployment
