# Xordi Automation Workbench

The Xordi Automation Workbench is an interactive browser environment for developing and testing TikTok sampling scripts - a key component of building "nooscope" tools for understanding algorithmic recommendations.

## What is the Workbench?

The workbench provides:
- **Single browser container** with remote debug access (WebRTC panel at 17.100.0.3:8080)
- **Playwright automation** with Chrome DevTools Protocol (CDP)
- **API instrumentation** to observe TikTok network calls
- **Development tools** for DOM inspection, screenshot capture, selector testing

This environment is specifically designed for:
- Understanding TikTok's web structure and API patterns
- Developing sampling scripts for For You Page and Watch History
- Testing authentication flows and session management
- Prototyping new automation behaviors

## Workbench vs Enclave

| Aspect | Workbench Mode | Enclave Mode |
|--------|---------------|--------------|
| **Purpose** | Script development | Production sampling |
| **Container** | Single browser, direct access | Multi-container orchestration |
| **Network** | Direct IP (17.100.0.3) | Isolated networks |
| **Debugging** | Full access, WebRTC panel | Minimal instrumentation |
| **Use Case** | Learning, prototyping | Auditing, TEE deployment |

The workbench is where you figure out *how* to sample. The enclave is where you run it *safely*.

## Quick Start

```bash
npm install                    # Install dependencies
npm run build                 # Build TypeScript
docker compose up -d          # Start workbench browser

# Try it out
node workbench.js --loggedout     # Sample public timeline (no auth)
node workbench.js auth            # Interactive login (scan QR)
node workbench.js                 # Sample your timeline
```

Access the browser debug panel: **http://17.100.0.3:8080** (password: "neko")

## Core CLI Commands

### Authentication
```bash
node workbench.js auth            # Interactive TikTok login (QR code)
node workbench.js health          # Check authentication status
node workbench.js save-session    # Save current browser session
```

### Sampling
```bash
node workbench.js --loggedout     # Sample 3 videos (public timeline)
node workbench.js                 # Sample 3 videos (your timeline)
node workbench.js 10              # Sample 10 videos
```

### Navigation & Inspection
```bash
node workbench.js screenshot      # Take browser screenshot
node workbench.js inspect         # Show current DOM structure
node workbench.js navigate foryou # Navigate to For You page
node workbench.js test video      # Test CSS selectors
```

### Container Management
```bash
node workbench.js start           # Start container
node workbench.js stop            # Stop container
node workbench.js status          # Check container status
```

## Workbench Tools

Individual tools are in `workbench-tools/` and can be run directly or via the CLI:

### DOM Inspector (`inspect-dom.js`)
Analyze TikTok page structure:
```bash
node workbench.js inspect           # Basic analysis
node workbench.js inspect --verbose # Show all data-e2e attributes
```

### Screenshot Tool (`screenshot.js`)
Capture browser state for debugging:
```bash
node workbench.js screenshot                    # Full page + mobile view
node workbench.js screenshot --viewport-only    # Just viewport
```

### Selector Tester (`test-selectors.js`)
Verify CSS selectors:
```bash
node workbench.js test                     # Test default selectors
node workbench.js test "video" "[data-e2e]"  # Test specific selectors
```

### Navigation Helper (`navigate.js`)
Quick page navigation:
```bash
node workbench.js navigate foryou    # Go to For You feed
node workbench.js navigate profile   # Go to profile
```

### Action Simulator (`simulate-actions.js`)
Test automation flows:
```bash
node workbench.js simulate scroll-test     # Test scrolling
node workbench.js simulate like-test       # Test liking videos
```

### Session Recorder (`record-session.js`)
Record interactions and generate Playwright code:
```bash
node workbench.js record my-session    # Start recording
# Interact with browser...
# Press Ctrl+C to stop
```

See `workbench-tools/README.md` for detailed tool documentation.

## Development Workflow

### 1. Start Workbench
```bash
docker compose up -d
node workbench.js status  # Verify running
```

### 2. Authenticate (if needed)
```bash
node workbench.js auth  # Scan QR code
# Session saved to output/tiktok-auth-*.json
```

### 3. Explore & Prototype
```bash
node workbench.js navigate foryou  # Go to target page
node workbench.js inspect          # See available elements
node workbench.js screenshot       # Visual snapshot
```

### 4. Test Selectors
```bash
node workbench.js test "[data-e2e='video-desc']"
node workbench.js test "div.video-container"
```

### 5. Develop Sampling Logic
Edit `lib/browser-automation-client.ts` or `lib/web-api-client.ts`:
```bash
npm run build
node workbench.js 5  # Test with 5 videos
```

### 6. Record Complex Flows
```bash
node workbench.js record debug-session
# Manually interact
# Get Playwright code output
```

### 7. Clean Up
```bash
node workbench.js stop
```

## Understanding TikTok Sampling

The workbench helps you understand two main sampling approaches:

### Browser Automation (Playwright)
- Uses `lib/browser-automation-client.ts`
- Navigates TikTok like a user
- Extracts data from DOM elements
- Works for any visible content
- More robust to API changes

### API Sampling (Module-based)
- Uses `lib/web-api-client.ts` or `lib/mobile-api-client.ts`
- Calls TikTok's undocumented APIs directly
- Requires reverse-engineered authentication
- Faster and lighter weight
- More fragile (API changes break it)

The workbench lets you develop both approaches. The enclave runs them securely.

## Proxy Support

Route traffic through SOCKS5 proxy:

```bash
# SSH SOCKS proxy
ssh -D 0.0.0.0:1080 -C -N user@remote-server

# Use proxy with workbench
SOCKS_PROXY=socks5://17.100.0.1:1080 docker compose up -d
SOCKS_PROXY=socks5://17.100.0.1:1080 node workbench.js auth
```

## Output Files

```
output/
├── tiktok-auth-*.json        # Authentication sessions
├── timeline-*.json           # Sampled data (JSON)
├── timeline-*.txt            # Human-readable output
└── screenshots/              # Browser screenshots
```

## Debugging Tips

**No active page found:**
- Run `node workbench.js start` first
- Check `node workbench.js status`

**Selectors not working:**
- Use `node workbench.js inspect` to see current page
- TikTok may have changed HTML structure

**Extraction returning empty data:**
- Use `node workbench.js inspect --verbose`
- Check if you're on the right page type

**View browser directly:**
- Open http://17.100.0.3:8080 (password: "neko")
- Click keyboard icon to take control

## From Workbench to Enclave

Once your sampling scripts work in the workbench:

1. **Test in enclave mode:**
   ```bash
   npm run start:audit
   node enclave-examples/dashboard.js
   # Access dashboard at http://localhost:4000
   ```

2. **Build deterministic enclave:**
   ```bash
   ./scripts/build-deterministic.sh
   ```

3. **Deploy to production:**
   See `README.md` enclave section for deployment details.

The workbench is for experimentation. The enclave is for trust.

## Design Principles

### Keep Complexity Outside the Enclave
The workbench is where you deal with complexity:
- Understanding TikTok's changing DOM structure
- Reverse engineering API authentication
- Handling network failures and retries
- Developing response transformations

The enclave only runs what you've proven works.

### Instrument Everything
The workbench provides visibility:
- Browser debug panel (WebRTC)
- Network call interception
- DOM inspection tools
- Screenshot capture
- Session recording

In the enclave, instrumentation is minimal (trust boundary).

### Fail Fast
The workbench lets errors surface immediately:
- No retry logic (let it fail)
- Minimal exception handling (see the error)
- Direct access to browser (inspect manually)

This helps you understand what's actually happening.

## Related Documentation

- `README.md` - Overall project introduction
- `workbench-tools/README.md` - Detailed tool documentation
- `docs/api-spec.md` - Enclave API reference
- `logical-proof-framework.md` - TCB verification framework
