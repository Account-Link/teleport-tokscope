# Teleport TikTok Nooscope

Tools for collecting and analyzing your TikTok recommendations and watch history. Build a personal "nooscope" to understand content recommendation patterns, track meme propagation, and analyze sentiment shifts over time.

![Demo](nooscope.gif)



## Quick Start

**No TikTok account needed to get started!**

```bash
npm install && npm run build      # Install and build
docker compose up -d              # Start browser container

# Option 1: Web Interface (recommended)
node examples/tokscope-web.js     # Visit http://localhost:8001

# Option 2: Command-line
node tokscope.js sample           # Collect 20 videos from public For You
node tokscope.js status           # Check what you've collected
```

**Output organized by type:**
```
output/nooscope/
├── public-foryou/           # Public timeline samples
├── authenticated-foryou/    # Your personalized feed
└── watch-history/           # What you've watched
```

**Authenticate for personalized data:**

```bash
node tokscope.js auth              # Shows QR code in terminal
node tokscope.js sample --auth     # Sample your personalized feed
node tokscope.js watch-history     # Collect your watch history
```

Scan the QR code with TikTok mobile app. Session saved automatically.

**Commands:**
- `node tokscope.js sample` - Sample public For You feed
- `node tokscope.js sample --auth` - Sample your personalized feed
- `node tokscope.js auth` - Authenticate with QR code
- `node tokscope.js watch-history` - Collect watch history
- `node tokscope.js status` - Show collection status
- `node tokscope.js` - Interactive menu


## How It Works & Troubleshooting

The nooscope uses a containerized browser that you can watch in real-time:

**🔍 Watch the Browser:**
- **Web Interface:** Click "Show Viewer" in nooscope-web at http://localhost:8001
- **Direct Access:** Open http://localhost:8080 (username: `neko`, password: `neko`)

This is invaluable for:
- Verifying sampling is working
- Debugging authentication issues
- Understanding TikTok's page structure
- Taking manual control when needed

**Common Issues:**
- **"Connection refused"** - Run `docker compose up -d` to start the browser
- **"Not authenticated"** - Run `node tokscope.js auth` and scan QR code
- **"No videos collected"** - Check the neko viewer to see if TikTok loaded correctly
- **Authentication fails** - Try refreshing the browser in neko view before auth

## Documentation

- **[Architecture](docs/architecture.md)** - How Neko, Playwright, and CDP work together
- **[Workbench Guide](docs/workbench.md)** - Interactive development environment
- **[Enclave Guide](docs/enclave.md)** - TEE production deployment
- **[API Specification](docs/api-spec.md)** - Enclave API reference
- **[Module System](docs/module-system.md)** - Proprietary module loading

## For Developers: Workbench & Enclave

**Workbench** (`workbench.js`) - Interactive development environment:
- Build and test new sampling strategies
- Inspect DOM structure and test selectors
- Debug with screenshots and session recording
- See [docs/workbench.md](docs/workbench.md) for detailed guide

**Enclave** (TEE-ready) - Production deployment reference:
- Multi-container isolation with remote attestation
- Secure credential handling for remote nooscope services
- Reproducible builds for auditability
- See [docs/enclave.md](docs/enclave.md) for complete details

## Directory Structure

```
tokscope.js              # TikTok data collection CLI tool
workbench.js             # Workbench CLI for developers
examples/
├── tokscope-web.js          # Web UI with live browser viewer
├── enclave-dashboard.js     # Enclave-specific dashboard
├── viewer-client.html       # Standalone WebRTC viewer
└── response-transformers.js # Example data transformers
scripts/
└── viewer-server.js         # Reference viewer implementation
lib/                     # Shared TypeScript libraries
├── browser-automation-client.ts    # Playwright automation
├── web-api-client.ts              # TikTok web API
└── ...

workbench-tools/         # Workbench development tools
├── inspect-dom.js       # DOM analysis
├── screenshot.js        # Screenshot capture
├── test-selectors.js    # Selector testing
└── ...

tokscope-enclave/          # Enclave implementation
├── server.ts           # Enclave API server
├── browser-manager.ts  # Container orchestration
└── Dockerfile.*        # Container images

enclave-examples/       # Enclave client examples
├── dashboard.js        # Web dashboard for enclave
└── response-transformers.js  # API response transformation

tests/                  # Test suites
├── test-dev-*.js       # Workbench tests
└── enclave/            # Enclave tests

output/                 # Generated data
├── tiktok-auth-*.json  # Session files
├── timeline-*.json     # Sampling results
└── screenshots/        # Browser captures
```

## Proxy Support

Both workbench and enclave support SOCKS5 proxies:

```bash
# Workbench with proxy
SOCKS_PROXY=socks5://17.100.0.1:1080 docker compose up -d
SOCKS_PROXY=socks5://17.100.0.1:1080 node workbench.js auth

# Or set in environment
export SOCKS_PROXY=socks5://17.100.0.1:1080
```

See [WORKBENCH.md](WORKBENCH.md) for detailed proxy configuration.

# Enclave (TEE Reference Implementation)

The Xordi Enclave is a TEE (Trusted Execution Environment) reference implementation for running nooscope sampling as a trusted remote service. It provides remote attestation that credentials are only used for legitimate purposes.

**Quick start:**
```bash
# Development mode
docker compose -f docker-compose-audit.yml up --build

# Dashboard
node enclave-examples/dashboard.js  # Access at http://localhost:4000
```

**Key features:**
- Multi-container isolation with remote attestation
- Reproducible builds for verification
- Module system for proprietary API authentication
- Static analysis to prove credential safety

See [ENCLAVE.md](ENCLAVE.md) for complete documentation including:
- Reproducible build instructions
- DStack deployment
- Module system details
- API specification
- Testing procedures

## Contributing to Nooscope Tools

**Develop new sampling scripts:**
```bash
node workbench.js navigate foryou
node workbench.js inspect
node workbench.js test "div[data-e2e='video-title']"
```

**Document your findings:**
```bash
node workbench.js screenshot
# Saves: output/screenshots/foryou-YYYY-MM-DD.png
```

See [WORKBENCH.md](WORKBENCH.md) for detailed development workflows.

## Related Work

**Data donations**
The Teleport Noscope is most closely related to prior work on *data donations,* which rely on users using the "data download" feature of social media services and uploading these zip files to a data collector.
Compared to these, the main novelty in this collection method is the use of TEEs to carry this out remotely but in a secure way. 

On TikTok:
- [Analyzing User Engagement with TikTok's Short Format Video Recommendations using Data Donations](https://dl.acm.org/doi/fullHtml/10.1145/3613904.3642433) - Research on algorithmic transparency and content analysis
- [Washington Post TikTok Collection](https://omarshehata.substack.com/p/washington-post-is-collecting-tiktok) - Journalistic effort to understand TikTok's algorithm

On Twitter:
- [Community Archive](https://community-archive.org) - Decentralized social media archiving (inspiration for this work)

**Prior research and product prototypes from Teleport:**

- **[Setting Your Pet Rock Free](https://medium.com/@helltech/setting-your-pet-rock-free-3e7895201f46)** (2024) - First AI Agent that provably owns its own exclusive Twitter account using TEEs
- **[DelegaTEE: Brokered Delegation Using Trusted Execution Environments](https://www.usenix.org/conference/usenixsecurity18/presentation/matetic)** (2019) - introduced the notion of TEE for secure account delegation
- **[Teleport dot best](https://teleport.best/)** Uses TEE to create one-time-use tokens for posting on your Twitter/X account


## Acknowledgements

This work is sponsored by [Flashbots[X]](https://www.flashbots.net/), and is a collaboration with [Nous Research](https://nousresearch.com/), [Phala](https://phala.com/), and [Nothing](https://www.shl0ms.com/).

We are inspired by the Community Archive project, who we hope will find these tools useful for understanding social media content propagation and sentiment analysis.

We build on [neko](https://neko.m1k1o.net/) for the containerized browser with GStreamer/WebRTC viewing portal, and [playwright](https://playwright.dev/) for browser automation.

## Troubleshooting

**Workbench issues:** See [docs/workbench.md](docs/workbench.md#debugging-tips)
**Enclave issues:** Check `docker compose -f docker-compose-audit.yml logs`
**Build issues:** Ensure TypeScript compiled: `npm run build`