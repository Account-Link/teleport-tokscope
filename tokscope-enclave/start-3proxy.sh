#!/bin/bash

# Parse SOCKS5_PROXY URL: socks5://host:port:user:pass
if [[ -n "$SOCKS5_PROXY" && "$SOCKS5_PROXY" =~ ^socks5://([^:]+):([^:]+):([^:]+):(.+)$ ]]; then
    UPSTREAM_PROXY_HOST="${BASH_REMATCH[1]}"
    UPSTREAM_PROXY_PORT="${BASH_REMATCH[2]}"
    UPSTREAM_PROXY_USER="${BASH_REMATCH[3]}"
    UPSTREAM_PROXY_PASS="${BASH_REMATCH[4]}"

    echo "🔗 Starting SOCKS5 relay for authenticated upstream"
    echo "   Upstream: $UPSTREAM_PROXY_HOST:$UPSTREAM_PROXY_PORT (user: $UPSTREAM_PROXY_USER)"

    # Start Node.js relay using pre-built script
    export UPSTREAM_PROXY_HOST UPSTREAM_PROXY_PORT UPSTREAM_PROXY_USER UPSTREAM_PROXY_PASS
    exec node /usr/local/bin/simple-socks5-relay.js
else
    echo "ℹ️  No SOCKS5_PROXY with auth - relay not started"
    # Keep container running
    exec sleep infinity
fi