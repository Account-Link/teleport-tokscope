const net = require('net');

const LISTEN_PORT = 1080;
const UPSTREAM_HOST = process.env.UPSTREAM_PROXY_HOST;
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PROXY_PORT);
const UPSTREAM_USER = process.env.UPSTREAM_PROXY_USER;
const UPSTREAM_PASS = process.env.UPSTREAM_PROXY_PASS;

// SOCKS5 authentication with upstream proxy
function createAuthenticatedConnection(targetHost, targetPort, callback) {
    const upstreamSocket = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
    let step = 0;

    upstreamSocket.on('connect', () => {
        // Step 1: Send greeting with username/password auth
        upstreamSocket.write(Buffer.from([0x05, 0x01, 0x02])); // Version 5, 1 method, username/password
    });

    upstreamSocket.on('data', (data) => {
        if (step === 0) {
            // Step 2: Server should respond with method selection
            if (data[0] === 0x05 && data[1] === 0x02) {
                // Send username/password
                const userBuf = Buffer.from(UPSTREAM_USER);
                const passBuf = Buffer.from(UPSTREAM_PASS);
                const authBuf = Buffer.concat([
                    Buffer.from([0x01]), // Version 1
                    Buffer.from([userBuf.length]),
                    userBuf,
                    Buffer.from([passBuf.length]),
                    passBuf
                ]);
                upstreamSocket.write(authBuf);
                step = 1;
            } else {
                callback(new Error(`Auth method not supported: ${data[1]}`));
            }
        } else if (step === 1) {
            // Step 3: Auth response
            if (data[0] === 0x01 && data[1] === 0x00) {
                // Auth success, send connect request
                const hostBuf = Buffer.from(targetHost);
                const connectBuf = Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03]), // Version, connect, reserved, domain
                    Buffer.from([hostBuf.length]),
                    hostBuf,
                    Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]) // Port
                ]);
                upstreamSocket.write(connectBuf);
                step = 2;
            } else {
                callback(new Error(`Auth failed: ${data[1]}`));
            }
        } else if (step === 2) {
            // Step 4: Connect response
            if (data[0] === 0x05 && data[1] === 0x00) {
                callback(null, upstreamSocket);
            } else {
                callback(new Error(`Connect failed: ${data[1]}`));
            }
            step = 3;
        }
    });

    upstreamSocket.on('error', callback);
}

const server = net.createServer((clientSocket) => {
    let step = 0;

    clientSocket.on('data', (data) => {
        if (step === 0) {
            // SOCKS5 greeting
            if (data[0] === 0x05) {
                clientSocket.write(Buffer.from([0x05, 0x00])); // No authentication required
                step = 1;
            }
        } else if (step === 1) {
            // SOCKS5 connect request
            if (data[0] === 0x05 && data[1] === 0x01) {
                const addressType = data[3];
                let targetHost, targetPort;

                if (addressType === 0x01) { // IPv4
                    targetHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
                    targetPort = data.readUInt16BE(8);
                } else if (addressType === 0x03) { // Domain name
                    const domainLength = data[4];
                    targetHost = data.slice(5, 5 + domainLength).toString();
                    targetPort = data.readUInt16BE(5 + domainLength);
                }

                createAuthenticatedConnection(targetHost, targetPort, (err, upstreamSocket) => {
                    if (err) {
                        console.error('Failed to connect to upstream:', err.message);
                        clientSocket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                        clientSocket.destroy();
                        return;
                    }

                    // Success response
                    clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

                    // Relay data
                    clientSocket.pipe(upstreamSocket);
                    upstreamSocket.pipe(clientSocket);

                    const cleanup = () => {
                        clientSocket.destroy();
                        upstreamSocket.destroy();
                    };

                    clientSocket.on('error', cleanup);
                    upstreamSocket.on('error', cleanup);
                    clientSocket.on('close', cleanup);
                    upstreamSocket.on('close', cleanup);
                });
                step = 2;
            }
        }
    });

    clientSocket.on('error', (err) => {
        console.error('Client socket error:', err.message);
    });
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`SOCKS5 relay listening on port ${LISTEN_PORT}`);
    console.log(`Forwarding to ${UPSTREAM_HOST}:${UPSTREAM_PORT} with user ${UPSTREAM_USER}`);
});

server.on('error', (err) => {
    console.error('Server error:', err.message);
    process.exit(1);
});