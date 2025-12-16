const net = require('net');
const http = require('http');

const SOCKS_PORT = 1080;
const CONTROL_PORT = 1081;

// Mutable upstream config (updated via control API)
let upstreamConfig = {
  host: process.env.UPSTREAM_PROXY_HOST || null,
  port: parseInt(process.env.UPSTREAM_PROXY_PORT) || null,
  user: process.env.UPSTREAM_PROXY_USER || null,
  pass: process.env.UPSTREAM_PROXY_PASS || null
};

function isUpstreamConfigured() {
  return upstreamConfig.host && upstreamConfig.port && upstreamConfig.user && upstreamConfig.pass;
}

// Direct connection (passthrough mode)
function connectDirect(targetHost, targetPort, callback) {
  const socket = net.connect(targetPort, targetHost);
  socket.once('connect', () => callback(null, socket));
  socket.once('error', (err) => callback(err));
}

// SOCKS5 authenticated connection to upstream
function connectUpstream(targetHost, targetPort, callback) {
  if (!isUpstreamConfigured()) {
    return connectDirect(targetHost, targetPort, callback);
  }

  const socket = net.connect(upstreamConfig.port, upstreamConfig.host);
  let step = 0;

  socket.once('error', (err) => {
    callback(err);
    socket.destroy();
  });

  socket.once('connect', () => {
    // SOCKS5 greeting with username/password auth
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
  });

  socket.on('data', (data) => {
    if (step === 0) {
      if (data[0] === 0x05 && data[1] === 0x02) {
        // Send credentials
        const userBuf = Buffer.from(upstreamConfig.user);
        const passBuf = Buffer.from(upstreamConfig.pass);
        socket.write(Buffer.concat([
          Buffer.from([0x01, userBuf.length]),
          userBuf,
          Buffer.from([passBuf.length]),
          passBuf
        ]));
        step = 1;
      } else {
        callback(new Error('Auth method not supported'));
        socket.destroy();
      }
    } else if (step === 1) {
      if (data[0] === 0x01 && data[1] === 0x00) {
        // Auth success, send connect
        const hostBuf = Buffer.from(targetHost);
        socket.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
        ]));
        step = 2;
      } else {
        callback(new Error('Auth failed'));
        socket.destroy();
      }
    } else if (step === 2) {
      if (data[0] === 0x05 && data[1] === 0x00) {
        callback(null, socket);
      } else {
        callback(new Error('Connect failed'));
        socket.destroy();
      }
      step = 3;
    }
  });
}

// SOCKS5 server (local clients connect here)
const socksServer = net.createServer((client) => {
  let step = 0;

  client.once('error', () => {});

  client.on('data', (data) => {
    if (step === 0 && data[0] === 0x05) {
      client.write(Buffer.from([0x05, 0x00])); // No auth for local
      step = 1;
    } else if (step === 1 && data[0] === 0x05 && data[1] === 0x01) {
      const atyp = data[3];
      let targetHost, targetPort;

      if (atyp === 0x01) { // IPv4
        targetHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
        targetPort = data.readUInt16BE(8);
      } else if (atyp === 0x03) { // Domain
        const len = data[4];
        targetHost = data.slice(5, 5 + len).toString();
        targetPort = data.readUInt16BE(5 + len);
      } else {
        client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }

      connectUpstream(targetHost, targetPort, (err, upstream) => {
        if (err) {
          console.error(`[relay] ${targetHost}:${targetPort} failed: ${err.message}`);
          client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
          return;
        }

        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream);
        upstream.pipe(client);

        const cleanup = () => { client.destroy(); upstream.destroy(); };
        client.once('error', cleanup);
        client.once('close', cleanup);
        upstream.once('error', cleanup);
        upstream.once('close', cleanup);
      });
      step = 2;
    }
  });
});

// HTTP Control API (browser-manager calls this)
const controlServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/configure') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (!cfg.host || !cfg.port || !cfg.user || !cfg.pass) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing: host, port, user, pass' }));
          return;
        }
        upstreamConfig = {
          host: cfg.host,
          port: parseInt(cfg.port),
          user: cfg.user,
          pass: cfg.pass
        };
        console.log(`[relay] Configured: ${upstreamConfig.host}:${upstreamConfig.port}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mode: 'proxied' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mode: isUpstreamConfigured() ? 'proxied' : 'passthrough',
      upstream: isUpstreamConfigured() ? `${upstreamConfig.host}:${upstreamConfig.port}` : null
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Start servers
socksServer.listen(SOCKS_PORT, '127.0.0.1', () => {
  console.log(`[relay] SOCKS5 on 127.0.0.1:${SOCKS_PORT} (${isUpstreamConfigured() ? 'proxied' : 'passthrough'})`);
});

controlServer.listen(CONTROL_PORT, '0.0.0.0', () => {
  console.log(`[relay] Control API on 0.0.0.0:${CONTROL_PORT}`);
});

socksServer.on('error', (err) => { console.error('[relay] SOCKS error:', err.message); process.exit(1); });
controlServer.on('error', (err) => { console.error('[relay] Control error:', err.message); process.exit(1); });
