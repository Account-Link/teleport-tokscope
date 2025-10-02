# Development Tools

This directory contains individual development tools for building and testing TikTok automation scripts with Xordi Lite.

## 🔧 **Integration Notice**

**These tools are now integrated into the main `coscroll.js` script!**

- ✅ **Recommended**: Use `node workbench.js <command>` for the integrated experience
- ⚡ **Alternative**: You can still run individual tools directly if needed (e.g., `node dev-tools/inspect-dom.js`)

The integrated approach provides better container management and a unified workflow.

## Quick Start

```bash
# Start development environment
node workbench.js start

# Explore the current page
node workbench.js inspect

# Take a screenshot
node workbench.js screenshot

# Test your selectors
node workbench.js test

# Stop when done
node workbench.js stop
```

## Available Tools

### 🔍 DOM Inspector (`inspect-dom.js`)
Analyzes the current browser page and shows TikTok-specific elements.

```bash
node workbench.js inspect           # Basic analysis
node workbench.js inspect --verbose # Show all data-e2e attributes
```

**Shows:**
- Current page URL and type (video, foryou, profile)
- All TikTok elements with data-e2e attributes
- Video elements and their properties
- Interactive elements (buttons, links)
- Element visibility and positions

### 📸 Screenshot Tool (`screenshot.js`)
Takes screenshots of the current browser state for debugging.

```bash
node workbench.js screenshot                    # Full page + mobile view
node workbench.js screenshot --viewport-only    # Just viewport
node workbench.js screenshot --no-mobile        # Skip mobile screenshot
node workbench.js screenshot --clip=100,200,800,600  # Specific area
```

**Features:**
- Automatic desktop and mobile screenshots
- Video element screenshots on video pages
- Organized output in `output/screenshots/`

### 🧪 Selector Tester (`test-selectors.js`)
Tests CSS selectors against the current page to verify they work.

```bash
node workbench.js test                     # Test default TikTok selectors
node workbench.js test "video" "[data-e2e]"  # Test specific selectors
node workbench.js test 'button[data-e2e*="like"]'  # Test like buttons
```

**Shows:**
- How many elements match each selector
- Which elements are visible vs hidden
- Element details (text, attributes, position)
- Success/failure summary

### 🔬 Data Extraction Tester (`extract-data.js`)
Tests the data extraction logic used in the main sampler.

```bash
node workbench.js extract           # Test extraction
node workbench.js extract --verbose # Show extraction steps
node workbench.js extract --debug   # Show all debug info
```

**Tests:**
- Video ID extraction from URL
- Author and nickname extraction
- Description extraction
- Stats extraction (likes, comments, shares)
- Quality assessment and suggestions

### 🎮 Action Simulator (`simulate-actions.js`)
Simulates user actions for testing automation flows.

```bash
node workbench.js simulate default         # Default test sequence
node workbench.js simulate scroll-test     # Test scrolling
node workbench.js simulate like-test       # Test liking videos
node workbench.js simulate navigation-test # Test page navigation
```

**Actions available:**
- `navigate(url)` - Go to URL
- `clickVideo()` - Click first video
- `nextVideo()` - Navigate to next video
- `scroll(direction, count)` - Scroll up/down
- `like()` - Like current video
- `screenshot(name)` - Take screenshot

### 🎬 Session Recorder (`record-session.js`)
Records browser interactions and generates Playwright code.

```bash
node workbench.js record my-session    # Start recording
# Interact with browser...
# Press Ctrl+C to stop and generate reports
```

**Generates:**
- Detailed event log (JSON)
- Playwright replay script
- Session summary with stats
- API call monitoring

### 🌐 Navigation Helper (`navigate.js`)
Quick navigation to common TikTok pages.

```bash
node workbench.js navigate foryou    # Go to For You feed
node workbench.js navigate profile   # Go to profile
node workbench.js navigate home      # Go to homepage
node workbench.js navigate "https://custom-url"  # Custom URL
```

## Development Workflow

### 1. Environment Setup
```bash
node workbench.js start    # Start browser container (once)
```

### 2. Explore Current State
```bash
node workbench.js navigate foryou  # Go to For You page
node workbench.js inspect          # See what elements are available
node workbench.js screenshot       # Take visual snapshot
```

### 3. Test Selectors
```bash
node workbench.js test "[data-e2e='video-desc']"  # Test description selector
node workbench.js test "video"                    # Test video elements
```

### 4. Develop Extraction Logic
```bash
node workbench.js extract --debug  # Test current extraction
# Edit lib/browser-automation-client.js
node workbench.js extract --debug  # Test again
```

### 5. Test Automation Flow
```bash
node workbench.js simulate scroll-test  # Test navigation
node workbench.js 5 --keep              # Test full coscroll with container reuse
```

### 6. Record for Analysis
```bash
node workbench.js record debug-session
# Manually interact with browser
# Ctrl+C to stop and get Playwright code
```

### 7. Cleanup
```bash
node workbench.js stop  # Stop container when done
```

## Output Locations

- **Screenshots**: `output/screenshots/`
- **Recordings**: `output/recordings/`
- **Sample Data**: `output/`

## Tips for Contributors

1. **Use inspect first** - Always check what elements are available before writing selectors
2. **Test selectors individually** - Use the test tool to verify selectors work
3. **Take screenshots** - Visual debugging is invaluable
4. **Record sessions** - Get Playwright code for complex interactions
5. **Test extraction logic** - Verify data extraction works on different page states

## Troubleshooting

**"No active page found"**
- Run `node workbench.js start` first
- Check `node workbench.js status` to see if container is running

**Selectors not working**
- Use `node workbench.js inspect` to see current page structure
- TikTok may have changed their HTML structure

**Extraction returning empty data**
- Use `node workbench.js extract --debug` to see extraction steps
- Check if you're on the right page type (video vs feed)

**Navigation timeouts**
- Network issues or page taking too long to load
- Check browser manually, page might have actually loaded

## Recent Updates

**2025-09-17**: Added TikTok like automation functionality to `simulate-actions.js`. Uses smart button indexing and container-specific scrolling. See `notes/2025-09-17-tiktok-like-automation.md` for detailed development process.