# TokScope Dev Configuration

Development-specific configuration for browser containers used by `docker-compose.yml`.

## Files

### `chromium.conf`
Supervisord configuration for Chrome in dev mode:
- **Chrome DevTools Protocol (CDP)**: Enabled on port 9222 (internal)
- **Debug proxy**: Exposes CDP on port 9223 (external) via socat
- **Development optimizations**: Cleaner config than production
- **Window management**: Openbox for GUI session

## Usage in docker-compose.yml

Dev mode automatically uses this config:
```yaml
services:
  dev-browser:
    build:
      args:
        - CHROMIUM_CONF_SOURCE=tokscope-dev  # Uses tokscope-dev/chromium.conf
```

Production mode (docker-compose-audit.yml) defaults to `tokscope-enclave/chromium.conf`.

## DevTools Access

All dev-tools connect to the socat proxy on port 9223:
```javascript
// Example from dev-tools/screenshot.js:
const browser = await chromium.connectOverCDP(`http://17.${thirdOctet}.0.3:9223`);
```

The proxy forwards external connections to Chrome's internal CDP port (9222).