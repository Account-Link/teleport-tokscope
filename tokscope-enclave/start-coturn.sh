#!/bin/bash
# Resolve env vars in coturn config template, then start coturn
# Called by supervisord via /etc/neko/supervisord/coturn.conf

if [ -z "$TURN_PASSWORD" ]; then
  echo "[coturn] TURN_PASSWORD not set — coturn will not start (non-portal container)"
  # Sleep forever so supervisord doesn't restart-loop
  exec sleep infinity
fi

envsubst < /etc/coturn/turnserver.conf.template > /etc/coturn/turnserver.conf
exec /usr/bin/turnserver -c /etc/coturn/turnserver.conf
