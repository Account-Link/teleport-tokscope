#!/usr/bin/env bash
# test-qr-timing.sh — A/B test for chromium.conf flag changes
# Measures time from QR page navigation to canvas QR code appearing
#
# Usage: ./test-qr-timing.sh [old|new|both]
#   old  = current chromium.conf (baseline)
#   new  = optimized chromium.conf (v1.1.3F3)
#   both = run both and compare (default)

set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-both}"
NETWORK="test-qr-network"
WG_HOST="${WG_HOST:?WG_HOST env var required}"
WG_PORT="${WG_PORT:?WG_PORT env var required}"
WG_USER="${WG_USER:?WG_USER env var required}"
WG_PASS="${WG_PASS:?WG_PASS env var required}"
IMAGE="xordi-staging-tcb-browser:latest"

# Modified chromium.conf for v1.1.3F3
CHROMIUM_CONF_NEW=$(cat <<'CONF'
[program:socks5-relay]
command=/usr/bin/node /usr/local/bin/simple-socks5-relay.js
autorestart=true
priority=200
user=neko
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/chromium --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --remote-allow-origins=* --window-position=0,0 --display=%(ENV_DISPLAY)s --user-data-dir=/home/neko/.config/chromium --no-first-run --start-maximized --bwsi --force-dark-mode --disable-file-system --disable-gpu --no-sandbox --disable-setuid-sandbox --disable-features=IsolateOrigins,site-per-process --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --js-flags=--max-old-space-size=512 --proxy-server=socks5://127.0.0.1:1080
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:debug-proxy]
command=/usr/bin/socat TCP-LISTEN:9223,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:9222
autorestart=true
priority=900
user=neko
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true

[program:openbox]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/openbox --config-file /etc/neko/openbox.xml
autorestart=true
priority=300
user=%(ENV_USER)s
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
redirect_stderr=true
CONF
)

# The test JS script (injected into the container)
# Uses ONLY built-in Node.js modules (no ws/npm deps)
# Implements a minimal WebSocket client with RFC 6455 masking
TEST_SCRIPT=$(cat <<'JSEOF'
const http = require("http");
const crypto = require("crypto");
const net = require("net");

const CDP_PORT = 9222;

// Minimal WebSocket client using raw TCP (RFC 6455)
class SimpleWS {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.handlers = {};
    this.buffer = Buffer.alloc(0);
  }

  on(event, fn) { this.handlers[event] = fn; return this; }
  emit(event, ...args) { if (this.handlers[event]) this.handlers[event](...args); }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.socket = net.createConnection(parseInt(this.url.port) || 80, this.url.hostname, () => {
        const req = [
          `GET ${this.url.pathname} HTTP/1.1`,
          `Host: ${this.url.host}`,
          `Upgrade: websocket`,
          `Connection: Upgrade`,
          `Sec-WebSocket-Key: ${key}`,
          `Sec-WebSocket-Version: 13`,
          ``, ``
        ].join("\r\n");
        this.socket.write(req);
      });

      let gotUpgrade = false;
      this.socket.on("data", (chunk) => {
        if (!gotUpgrade) {
          const str = chunk.toString();
          if (str.includes("101")) {
            gotUpgrade = true;
            const bodyStart = str.indexOf("\r\n\r\n") + 4;
            if (bodyStart < chunk.length) {
              this.buffer = Buffer.concat([this.buffer, chunk.slice(bodyStart)]);
              this._parseFrames();
            }
            this.emit("open");
            resolve();
          } else {
            reject(new Error("WebSocket upgrade failed"));
          }
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._parseFrames();
      });

      this.socket.on("error", (e) => reject(e));
      this.socket.on("close", () => this.emit("close"));
    });
  }

  _parseFrames() {
    while (this.buffer.length >= 2) {
      const byte1 = this.buffer[0];
      const byte2 = this.buffer[1];
      const masked = (byte2 & 0x80) !== 0;
      let payloadLen = byte2 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (masked) offset += 4;
      if (this.buffer.length < offset + payloadLen) return;

      let payload = this.buffer.slice(offset, offset + payloadLen);
      if (masked) {
        const mask = this.buffer.slice(offset - 4, offset);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }

      this.buffer = this.buffer.slice(offset + payloadLen);
      const opcode = byte1 & 0x0f;
      if (opcode === 1) { // text frame
        this.emit("message", payload.toString("utf8"));
      } else if (opcode === 8) { // close
        this.close();
      } else if (opcode === 9) { // ping
        this._sendFrame(10, payload); // pong
      }
    }
  }

  send(data) {
    this._sendFrame(1, Buffer.from(data, "utf8"));
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
      mask.copy(header, 2);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      mask.copy(header, 10);
    }
    this.socket.write(Buffer.concat([header, masked]));
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      try { this._sendFrame(8, Buffer.alloc(0)); } catch {}
      this.socket.destroy();
    }
  }
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function getPageWsUrl() {
  const targets = await httpGet("/json/list");
  const page = targets.find(t => t.type === "page");
  return page ? page.webSocketDebuggerUrl : null;
}

async function cdpNavigate(wsUrl, url) {
  const ws = new SimpleWS(wsUrl);
  await ws.connect();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error("navigate timeout")); }, 30000);
    ws.on("message", (d) => {
      const msg = JSON.parse(d);
      if (msg.id === 1) { clearTimeout(timeout); ws.close(); resolve(msg); }
    });
    ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
  });
}

async function waitForCanvasQR(wsUrl) {
  const ws = new SimpleWS(wsUrl);
  await ws.connect();

  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const deadline = setTimeout(() => { ws.close(); reject(new Error("QR timeout 45s")); }, 45000);
    let pollId = 0;
    let pollInterval;
    let domContentMs = null;
    let loadMs = null;

    ws.on("message", (d) => {
      const msg = JSON.parse(d);

      // IMG QR detail check result
      if (msg.id === 50 && msg.result && msg.result.result) {
        console.log("  IMG details: " + (msg.result.result.value || "none"));
      }

      if (msg.method === "Page.domContentEventFired") {
        domContentMs = Date.now() - startMs;
        console.log(`  domcontentloaded: ${domContentMs}ms`);
      }
      if (msg.method === "Page.loadEventFired") {
        loadMs = Date.now() - startMs;
        console.log(`  load event: ${loadMs}ms`);
      }

      if (msg.id >= 200 && msg.result && msg.result.result) {
        const val = msg.result.result.value || "";
        const elapsed = Date.now() - startMs;

        if (val.startsWith("canvas:")) {
          console.log(`  CANVAS QR FOUND: ${val} at ${elapsed}ms`);
          clearInterval(pollInterval);
          clearTimeout(deadline);
          ws.close();
          resolve({ type: "canvas", elapsed, domContentMs, loadMs, detail: val });
        } else if (elapsed % 3000 < 400) {
          console.log(`  ${elapsed}ms: ${val}`);
        }
      }
    });

    // Enable events + navigate
    ws.send(JSON.stringify({ id: 1, method: "Page.enable", params: {} }));
    ws.send(JSON.stringify({ id: 2, method: "Runtime.enable", params: {} }));
    ws.send(JSON.stringify({ id: 10, method: "Page.navigate", params: { url: "https://www.tiktok.com/login/qrcode" } }));
    console.log("  Navigating to /login/qrcode...");

    // Also check what the IMG QR actually contains (login or promo?)
    let imgChecked = false;

    // Poll for canvas QR every 300ms
    setTimeout(() => {
      pollInterval = setInterval(() => {
        // One-time check: decode IMG QR to see if it's login or promotional
        if (!imgChecked) {
          imgChecked = true;
          ws.send(JSON.stringify({
            id: 50,
            method: "Runtime.evaluate",
            params: {
              expression: `(function() {
                var imgs = document.querySelectorAll('img');
                var result = [];
                for (var i = 0; i < imgs.length; i++) {
                  var img = imgs[i];
                  if (img.naturalWidth > 50 && img.complete) {
                    result.push({
                      src: img.src ? img.src.substring(0, 120) : 'none',
                      alt: img.alt || '',
                      size: img.naturalWidth + 'x' + img.naturalHeight,
                      square: img.naturalWidth === img.naturalHeight
                    });
                  }
                }
                return JSON.stringify(result);
              })()`
            }
          }));
        }

        ws.send(JSON.stringify({
          id: 200 + (++pollId),
          method: "Runtime.evaluate",
          params: {
            expression: `(function() {
              var cs = document.querySelectorAll('canvas');
              for (var i = 0; i < cs.length; i++) {
                if (cs[i].width > 100 && cs[i].height > 100) return 'canvas:' + cs[i].width + 'x' + cs[i].height;
              }
              var imgs = document.querySelectorAll('img');
              var imgInfo = '';
              for (var j = 0; j < imgs.length; j++) {
                if (imgs[j].naturalWidth > 50) imgInfo += imgs[j].naturalWidth + 'x' + imgs[j].naturalHeight + ' ';
              }
              return 'waiting:' + cs.length + 'c,' + imgs.length + 'i [' + imgInfo.trim() + ']';
            })()`
          }
        }));
      }, 300);
    }, 500);
  });
}

async function main() {
  console.log("Waiting for CDP...");
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    try { wsUrl = await getPageWsUrl(); if (wsUrl) break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!wsUrl) { console.error("CDP not available"); process.exit(1); }
  console.log("CDP ready: " + wsUrl);

  // Step 1: Pre-navigate to tiktok.com
  console.log("\n--- Step 1: Pre-navigate to tiktok.com ---");
  const preNavStart = Date.now();
  await cdpNavigate(wsUrl, "https://www.tiktok.com");
  console.log("  Navigation sent, waiting 5s for assets...");
  await new Promise(r => setTimeout(r, 5000));
  console.log(`  Pre-nav complete: ${Date.now() - preNavStart}ms total`);

  // Re-get wsUrl
  wsUrl = await getPageWsUrl();
  if (!wsUrl) { console.error("Lost page target"); process.exit(1); }

  // Step 2: QR page timing
  console.log("\n--- Step 2: Navigate to /login/qrcode ---");
  try {
    const result = await waitForCanvasQR(wsUrl);
    console.log("\n=== RESULT ===");
    console.log(`  QR type: ${result.type}`);
    console.log(`  domcontentloaded: ${result.domContentMs}ms`);
    console.log(`  load event: ${result.loadMs || "N/A"}ms`);
    console.log(`  QR visible: ${result.elapsed}ms`);
    console.log(`  QR render gap (after DCL): ${result.elapsed - (result.domContentMs || 0)}ms`);
  } catch (e) {
    console.error("FAILED: " + e.message);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
JSEOF
)

cleanup() {
  echo ""
  echo "Cleaning up..."
  docker rm -f test-qr-old test-qr-new 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
}
trap cleanup EXIT

run_test() {
  local name="$1"
  local container_name="$2"
  local extra_docker_args="${3:-}"
  local chromium_conf_override="${4:-}"

  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  TEST: $name"
  echo "╚══════════════════════════════════════════════════════╝"

  # Remove previous container
  docker rm -f "$container_name" 2>/dev/null || true

  # Create network if needed
  docker network create "$NETWORK" 2>/dev/null || true

  # Start container — match CVM deployed config
  local docker_cmd="docker run -d --name $container_name --network $NETWORK"
  docker_cmd+=" -e NEKO_DESKTOP_SCREEN=1920x1080@1"
  docker_cmd+=" -e NEKO_DESKTOP_SCALING=1.0"
  docker_cmd+=" --memory=2g --memory-reservation=512m --cpus=3"
  docker_cmd+=" $extra_docker_args"
  docker_cmd+=" $IMAGE"

  echo "Starting container..."
  eval $docker_cmd

  # Wait for supervisord
  sleep 6

  # If we have a custom chromium.conf, inject it and restart chromium
  if [ -n "$chromium_conf_override" ]; then
    echo "Injecting modified chromium.conf..."
    echo "$chromium_conf_override" | docker exec -i "$container_name" sh -c 'cat > /etc/neko/supervisord/chromium.conf'
    docker exec "$container_name" supervisorctl restart chromium
    sleep 4
  fi

  # Configure proxy (WireGuard)
  local container_ip
  container_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container_name")
  echo "Container IP: $container_ip"
  echo "Configuring proxy..."

  curl -s -X POST "http://$container_ip:1081/configure" \
    -H "Content-Type: application/json" \
    -d "{\"host\":\"$WG_HOST\",\"port\":$WG_PORT,\"user\":\"$WG_USER\",\"pass\":\"$WG_PASS\"}" || {
    echo "WARNING: Proxy config failed"
  }
  echo "Proxy configured"

  # Inject and run test script
  echo "$TEST_SCRIPT" | docker exec -i "$container_name" sh -c 'cat > /tmp/test-qr.js'
  echo ""
  echo "Running test..."
  timeout 90 docker exec "$container_name" node /tmp/test-qr.js 2>&1 || echo "Test timed out or failed"

  echo ""
  echo "Done: $name"
}

case "$MODE" in
  old)
    run_test "BASELINE (current flags)" "test-qr-old"
    ;;
  new)
    run_test "v1.1.3F3 (optimized flags)" "test-qr-new" "--shm-size=256m" "$CHROMIUM_CONF_NEW"
    ;;
  both)
    run_test "BASELINE (current flags)" "test-qr-old"
    run_test "v1.1.3F3 (optimized flags)" "test-qr-new" "--shm-size=256m" "$CHROMIUM_CONF_NEW"

    echo ""
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║  COMPARISON COMPLETE — check timings above           ║"
    echo "╚══════════════════════════════════════════════════════╝"
    ;;
  *)
    echo "Usage: $0 [old|new|both]"
    exit 1
    ;;
esac
