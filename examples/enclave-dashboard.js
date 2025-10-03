/**
 * TokScope Enclave Dashboard
 *
 * This example dashboard facilitates using the tokscope-enclave interface by providing:
 * - Web UI for managing TikTok authentication sessions (via QR code)
 * - Session persistence across restarts
 * - Visual controls for sampling For You page and Watch History
 * - Activity logging to see real-time API results
 *
 * The dashboard acts as a proxy to the enclave API, making it easier to test
 * and interact with the automation features without writing custom API clients.
 *
 * TODO: Not yet exercised from dashboard:
 * - Container management (add/delete containers) - no API endpoint exists yet
 * - Module-based sampling endpoints (/modules/*) - not implemented in server yet
 * - Direct session loading (only happens automatically after auth)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { transformRawResponse } = require('./response-transformers');

const app = express();
app.use(express.json());

const ENCLAVE_URL = process.env.ENCLAVE_URL || 'http://localhost:3000';
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 4000;
const SESSIONS_FILE = path.join(__dirname, 'dashboard-sessions.json');

// Session storage
let sessions = { sessions: {} };

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      console.log(`📂 Loaded ${Object.keys(sessions.sessions).length} sessions`);
    }
  } catch (err) {
    console.error('Failed to load sessions:', err.message);
    sessions = { sessions: {} };
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error('Failed to save sessions:', err.message);
  }
}

// Activity log (in-memory)
const activityLog = [];
function addActivity(message, details = null) {
  const timestamp = new Date().toISOString();
  activityLog.unshift({ timestamp, message, details });
  if (activityLog.length > 50) activityLog.pop();
}

loadSessions();
addActivity('Dashboard started');

// Proxy to enclave
async function enclaveRequest(endpoint, options = {}) {
  const url = `${ENCLAVE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

// Start auth session
app.post('/dashboard/auth/start', async (req, res) => {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const { status, data } = await enclaveRequest(`/auth/start/${sessionId}`, { method: 'POST' });

  if (status === 200) {
    addActivity(`Started auth session for ${sessionId.substring(0, 8)}...`);
    res.json({ authSessionId: data.authSessionId, sessionId });
  } else {
    res.status(status).json(data);
  }
});

// SSE stream for auth polling
app.get('/dashboard/auth-stream/:authSessionId', async (req, res) => {
  const { authSessionId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const poll = async () => {
    const { status, data } = await enclaveRequest(`/auth/poll/${authSessionId}`);

    if (status === 200) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      if (data.status === 'complete') {
        const sessionId = data.sessionData?.user?.sec_user_id;
        if (sessionId) {
          sessions.sessions[sessionId] = {
            sessionData: data.sessionData,
            metadata: {
              addedAt: new Date().toISOString(),
              lastActivity: new Date().toISOString(),
              lastAction: 'auth_complete',
              lastResult: null
            }
          };
          saveSessions();

          await enclaveRequest(`/load-session`, {
            method: 'POST',
            body: JSON.stringify({ sessionData: data.sessionData })
          });

          addActivity(`Auth completed for @${data.sessionData.user.username}`);
        }
        clearInterval(interval);
        res.end();
      } else if (data.status === 'failed') {
        clearInterval(interval);
        res.end();
      }
    }
  };

  const interval = setInterval(poll, 2000);
  poll();

  req.on('close', () => clearInterval(interval));
});

// Get sessions (from local storage + enclave health)
app.get('/dashboard/sessions', async (req, res) => {
  const { data: health } = await enclaveRequest('/health');

  const sessionList = Object.entries(sessions.sessions).map(([id, session]) => ({
    id: id.substring(0, 8),
    fullId: id,
    username: session.sessionData.user?.username,
    nickname: session.sessionData.user?.nickname,
    addedAt: session.metadata.addedAt,
    lastActivity: session.metadata.lastActivity,
    lastAction: session.metadata.lastAction,
    lastResult: session.metadata.lastResult
  }));

  res.json({ sessions: sessionList, health });
});

// Delete session
app.delete('/dashboard/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const fullId = Object.keys(sessions.sessions).find(id => id.startsWith(sessionId));

  if (fullId) {
    const username = sessions.sessions[fullId].sessionData.user?.username;
    delete sessions.sessions[fullId];
    saveSessions();
    addActivity(`Deleted session for @${username}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Sample videos
app.post('/dashboard/sample', async (req, res) => {
  const { sessionId, type, count, method } = req.body;
  const fullId = Object.keys(sessions.sessions).find(id => id.startsWith(sessionId));

  if (!fullId) {
    return res.status(404).json({ error: 'Session not found' });
  }

  let endpoint, requestBody;
  if (method === 'playwright') {
    endpoint = `/playwright/${type}/sample/${fullId}`;
    requestBody = { count };
  } else if (method === 'web' || method === 'mobile') {
    endpoint = `/modules/${type}/sample/${fullId}`;
    requestBody = { module_type: method, count };
  } else {
    return res.status(400).json({ error: 'Invalid method' });
  }

  const { status, data } = await enclaveRequest(endpoint, {
    method: 'POST',
    body: JSON.stringify(requestBody)
  });

  if (status === 200 && data.success) {
    // Transform raw response on client side (outside enclave)
    let videos;
    if (data.raw) {
      videos = transformRawResponse(data.raw);
    } else if (data.videos) {
      // Backward compatibility for browser automation responses
      videos = data.videos;
    } else {
      videos = [];
    }

    const username = sessions.sessions[fullId].sessionData.user?.username;
    sessions.sessions[fullId].metadata.lastActivity = new Date().toISOString();
    sessions.sessions[fullId].metadata.lastAction = `sample_${type}`;
    sessions.sessions[fullId].metadata.lastResult = { count: videos.length, method: data.method || method };
    saveSessions();

    addActivity(`Sampled ${videos.length} videos for @${username} (${type})`, { videos });

    // Return transformed response
    res.status(status).json({ success: true, videos, statusCode: data.statusCode });
  } else {
    res.status(status).json(data);
  }
});

// Get activity log
app.get('/dashboard/activity', (req, res) => {
  res.json({ activities: activityLog });
});

// Container management
app.get('/dashboard/containers', async (req, res) => {
  const { status, data } = await enclaveRequest('/containers');
  res.status(status).json(data);
});

app.post('/dashboard/containers', async (req, res) => {
  const { proxy } = req.body;
  const { status, data } = await enclaveRequest('/containers/create', {
    method: 'POST',
    body: JSON.stringify({ proxy })
  });

  if (status === 200) {
    addActivity(`Created browser container ${data.containerId.substring(0, 12)}...`);
  }

  res.status(status).json(data);
});

app.delete('/dashboard/containers/:containerId', async (req, res) => {
  const { containerId } = req.params;
  const { status, data } = await enclaveRequest(`/containers/${containerId}`, { method: 'DELETE' });

  if (status === 200) {
    addActivity(`Deleted container ${containerId.substring(0, 12)}...`);
  }

  res.status(status).json(data);
});

// Health
app.get('/dashboard/health', async (req, res) => {
  const { status, data } = await enclaveRequest('/health');
  res.status(status).json(data);
});

// Serve UI
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>TokScope Enclave Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; }
    .header { background: #1a1a1a; color: white; padding: 1rem 2rem; }
    .header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .status { display: flex; gap: 2rem; font-size: 0.9rem; opacity: 0.9; }
    .status span { display: flex; align-items: center; gap: 0.5rem; }
    .indicator { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; }
    .indicator.degraded { background: #fbbf24; }
    .container { max-width: 1200px; margin: 2rem auto; padding: 0 2rem; }
    .section { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .section h2 { font-size: 1.2rem; margin-bottom: 1rem; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    button.danger { background: #dc2626; }
    button.danger:hover { background: #b91c1c; }
    button.secondary { background: #6b7280; }
    button.secondary:hover { background: #4b5563; }
    .session-card { border: 1px solid #e5e7eb; border-radius: 6px; padding: 1rem; margin-bottom: 0.75rem; }
    .session-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.75rem; }
    .session-info { flex: 1; }
    .session-title { font-weight: 600; font-size: 1rem; margin-bottom: 0.25rem; }
    .session-meta { font-size: 0.85rem; color: #6b7280; }
    .session-actions { display: flex; gap: 0.5rem; }
    .activity-item { border-left: 3px solid #2563eb; padding: 0.75rem 1rem; margin-bottom: 0.75rem; background: #f9fafb; }
    .activity-time { font-size: 0.85rem; color: #6b7280; margin-bottom: 0.25rem; }
    .activity-message { font-weight: 500; margin-bottom: 0.5rem; }
    .video-list { margin-top: 0.5rem; padding-left: 1rem; }
    .video-item { font-size: 0.9rem; margin-bottom: 0.25rem; }
    .video-item a { color: #2563eb; text-decoration: none; }
    .video-item a:hover { text-decoration: underline; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000; }
    .modal.show { display: flex; }
    .modal-content { background: white; border-radius: 8px; padding: 2rem; max-width: 500px; width: 90%; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
    .modal-close { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: #6b7280; padding: 0; }
    .qr-container { text-align: center; margin: 1rem 0; }
    .qr-container img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 4px; }
    .qr-status { font-size: 0.9rem; color: #6b7280; margin-top: 1rem; }
    .input-group { margin-bottom: 1rem; }
    .input-group label { display: block; margin-bottom: 0.25rem; font-size: 0.9rem; font-weight: 500; }
    .input-group input, .input-group select { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>TokScope Enclave Dashboard</h1>
    <div class="status">
      <span><div class="indicator" id="statusIndicator"></div><span id="statusText">Connecting...</span></span>
      <span id="sessionCount">Sessions: -/-</span>
      <span id="containers">Containers: -</span>
      <span id="uptime">Uptime: -</span>
    </div>
  </div>

  <div class="container">
    <div class="section">
      <button onclick="startAuth()">+ New Auth Session</button>
    </div>

    <div class="section">
      <h2>Active Sessions</h2>
      <div id="sessionList">Loading...</div>
    </div>

    <div class="section">
      <h2>Browser Containers</h2>
      <button onclick="openContainerModal()">+ Create Container</button>
      <div id="containerList" style="margin-top: 1rem;">Loading...</div>
    </div>

    <div class="section">
      <h2>Recent Activity</h2>
      <div id="activityList">Loading...</div>
    </div>
  </div>

  <div class="modal" id="authModal">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Scan QR Code</h2>
        <button class="modal-close" onclick="closeAuthModal()">×</button>
      </div>
      <div class="qr-container">
        <img id="qrImage" src="" alt="QR Code" style="display:none">
        <div id="qrStatus" class="qr-status">Starting authentication...</div>
      </div>
    </div>
  </div>

  <div class="modal" id="sampleModal">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Sample Videos</h2>
        <button class="modal-close" onclick="closeSampleModal()">×</button>
      </div>
      <div class="input-group">
        <label>Type</label>
        <select id="sampleType">
          <option value="foryoupage">For You Page</option>
          <option value="watchhistory">Watch History</option>
        </select>
      </div>
      <div class="input-group">
        <label>Count</label>
        <input type="number" id="sampleCount" value="3" min="1" max="20">
      </div>
      <div class="input-group">
        <label>Method</label>
        <select id="sampleMethod">
          <option value="playwright">Browser Automation</option>
          <option value="web">Module API (Web)</option>
          <option value="mobile">Module API (Mobile)</option>
        </select>
      </div>
      <button onclick="executeSample()">Start Sampling</button>
    </div>
  </div>

  <div class="modal" id="containerModal">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Create Browser Container</h2>
        <button class="modal-close" onclick="closeContainerModal()">×</button>
      </div>
      <div class="input-group">
        <label>Proxy (optional)</label>
        <select id="proxyType">
          <option value="">No Proxy</option>
          <option value="socks5">SOCKS5</option>
        </select>
      </div>
      <div id="proxyFields" style="display: none;">
        <div class="input-group">
          <label>Host</label>
          <input type="text" id="proxyHost" placeholder="proxy.example.com">
        </div>
        <div class="input-group">
          <label>Port</label>
          <input type="number" id="proxyPort" placeholder="1080">
        </div>
        <div class="input-group">
          <label>Username (optional)</label>
          <input type="text" id="proxyUsername">
        </div>
        <div class="input-group">
          <label>Password (optional)</label>
          <input type="password" id="proxyPassword">
        </div>
      </div>
      <button onclick="createContainer()">Create Container</button>
    </div>
  </div>

  <script>
    let currentAuthEventSource = null;
    let currentSampleSessionId = null;
    let availableModules = { web: false, mobile: false };

    async function fetchJSON(url, options = {}) {
      const response = await fetch(url, options);
      return response.json();
    }

    async function checkModuleAvailability() {
      try {
        const health = await fetchJSON('/dashboard/health');
        availableModules = health.modules || { web: false, mobile: false };
        console.log('📦 Module availability:', availableModules);
      } catch (err) {
        console.error('Failed to check module availability:', err);
      }
    }

    async function updateHealth() {
      try {
        const health = await fetchJSON('/dashboard/health');
        const indicator = document.getElementById('statusIndicator');
        const statusText = document.getElementById('statusText');

        if (health.status === 'healthy') {
          indicator.className = 'indicator';
          statusText.textContent = 'Connected';
        } else {
          indicator.className = 'indicator degraded';
          statusText.textContent = 'Degraded';
        }

        document.getElementById('sessionCount').textContent =
          \`Sessions: \${health.activeSessions || 0}/\${health.maxSessions || 10}\`;
        document.getElementById('containers').textContent =
          \`Containers: \${health.browserContainers?.available || 0} available\`;

        const uptimeMin = Math.floor((health.uptime || 0) / 60);
        const uptimeHr = Math.floor(uptimeMin / 60);
        document.getElementById('uptime').textContent =
          \`Uptime: \${uptimeHr}h \${uptimeMin % 60}m\`;
      } catch (err) {
        document.getElementById('statusIndicator').className = 'indicator degraded';
        document.getElementById('statusText').textContent = 'Disconnected';
      }
    }

    async function updateSessions() {
      try {
        const data = await fetchJSON('/dashboard/sessions');
        const list = document.getElementById('sessionList');

        if (data.sessions.length === 0) {
          list.innerHTML = '<p style="color:#6b7280">No active sessions</p>';
          return;
        }

        list.innerHTML = data.sessions.map(session => \`
          <div class="session-card">
            <div class="session-header">
              <div class="session-info">
                <div class="session-title">@\${session.username} (\${session.nickname})</div>
                <div class="session-meta">\${session.fullId.substring(0, 12)}...</div>
                <div class="session-meta">Last: \${session.lastActivity ? new Date(session.lastActivity).toLocaleTimeString() : 'never'}</div>
                \${session.lastResult ? \`<div class="session-meta">(\${session.lastResult.count} videos via \${session.lastResult.method})</div>\` : ''}
              </div>
            </div>
            <div class="session-actions">
              <button class="secondary" onclick="openSampleModal('\${session.id}')">Sample</button>
              <button class="danger" onclick="deleteSession('\${session.id}')">Delete</button>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        document.getElementById('sessionList').innerHTML = '<p style="color:#dc2626">Failed to load sessions</p>';
      }
    }

    async function updateActivity() {
      try {
        const data = await fetchJSON('/dashboard/activity');
        const list = document.getElementById('activityList');

        if (data.activities.length === 0) {
          list.innerHTML = '<p style="color:#6b7280">No recent activity</p>';
          return;
        }

        list.innerHTML = data.activities.slice(0, 10).map(activity => {
          const time = new Date(activity.timestamp).toLocaleTimeString();
          let html = \`
            <div class="activity-item">
              <div class="activity-time">\${time}</div>
              <div class="activity-message">\${activity.message}</div>
          \`;

          if (activity.details?.videos) {
            html += '<div class="video-list">';
            activity.details.videos.forEach((video, i) => {
              html += \`<div class="video-item">\${i + 1}. "\${video.description}" by @\${video.author} → <a href="\${video.url}" target="_blank">View</a></div>\`;
            });
            html += '</div>';
          }

          html += '</div>';
          return html;
        }).join('');
      } catch (err) {
        document.getElementById('activityList').innerHTML = '<p style="color:#dc2626">Failed to load activity</p>';
      }
    }

    async function startAuth() {
      try {
        const data = await fetchJSON('/dashboard/auth/start', { method: 'POST' });
        document.getElementById('authModal').classList.add('show');
        document.getElementById('qrImage').style.display = 'none';
        document.getElementById('qrStatus').textContent = 'Connecting...';

        if (currentAuthEventSource) {
          currentAuthEventSource.close();
        }

        currentAuthEventSource = new EventSource(\`/dashboard/auth-stream/\${data.authSessionId}\`);

        currentAuthEventSource.onmessage = (event) => {
          const authData = JSON.parse(event.data);

          if (authData.status === 'awaiting_scan' && authData.qrCodeData) {
            document.getElementById('qrImage').src = authData.qrCodeData;
            document.getElementById('qrImage').style.display = 'block';
            document.getElementById('qrStatus').textContent = 'Scan with TikTok app';
          } else if (authData.status === 'complete') {
            document.getElementById('qrStatus').textContent = 'Authentication successful!';
            setTimeout(() => {
              closeAuthModal();
              updateSessions();
            }, 1500);
          } else if (authData.status === 'failed') {
            document.getElementById('qrStatus').textContent = 'Authentication failed';
          }
        };

        currentAuthEventSource.onerror = () => {
          document.getElementById('qrStatus').textContent = 'Connection lost';
        };
      } catch (err) {
        alert('Failed to start auth: ' + err.message);
      }
    }

    function closeAuthModal() {
      document.getElementById('authModal').classList.remove('show');
      if (currentAuthEventSource) {
        currentAuthEventSource.close();
        currentAuthEventSource = null;
      }
    }

    function openSampleModal(sessionId) {
      currentSampleSessionId = sessionId;

      // Populate method dropdown based on available modules
      const methodSelect = document.getElementById('sampleMethod');
      methodSelect.innerHTML = '<option value="playwright">Browser Automation</option>';

      if (availableModules.web) {
        methodSelect.innerHTML += '<option value="web">Module API (Web)</option>';
      }
      if (availableModules.mobile) {
        methodSelect.innerHTML += '<option value="mobile">Module API (Mobile)</option>';
      }

      document.getElementById('sampleModal').classList.add('show');
    }

    function closeSampleModal() {
      document.getElementById('sampleModal').classList.remove('show');
      currentSampleSessionId = null;
    }

    async function executeSample() {
      const type = document.getElementById('sampleType').value;
      const count = parseInt(document.getElementById('sampleCount').value);
      const method = document.getElementById('sampleMethod').value;
      const sessionId = currentSampleSessionId;

      try {
        closeSampleModal();
        const data = await fetchJSON('/dashboard/sample', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, type, count, method })
        });

        if (data.success) {
          await updateSessions();
          await updateActivity();
        } else {
          alert('Sampling failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Sampling failed: ' + err.message);
      }
    }

    async function deleteSession(sessionId) {
      if (!confirm('Delete this session?')) return;

      try {
        await fetchJSON(\`/dashboard/sessions/\${sessionId}\`, { method: 'DELETE' });
        updateSessions();
        updateActivity();
      } catch (err) {
        alert('Failed to delete session: ' + err.message);
      }
    }

    async function updateContainers() {
      try {
        const data = await fetchJSON('/dashboard/containers');
        const list = document.getElementById('containerList');

        if (data.total === 0) {
          list.innerHTML = '<p style="color:#6b7280">No containers</p>';
          return;
        }

        list.innerHTML = data.containers.map(container => \`
          <div class="session-card">
            <div class="session-header">
              <div class="session-info">
                <div class="session-title">\${container.containerId.substring(0, 16)}...</div>
                <div class="session-meta">IP: \${container.ip} | Status: \${container.status}</div>
                \${container.sessionId ? \`<div class="session-meta">Session: \${container.sessionId.substring(0, 8)}...</div>\` : ''}
              </div>
            </div>
            <div class="session-actions">
              <button class="danger" onclick="deleteContainer('\${container.containerId}')">Delete</button>
            </div>
          </div>
        \`).join('');
      } catch (err) {
        document.getElementById('containerList').innerHTML = '<p style="color:#dc2626">Failed to load containers</p>';
      }
    }

    function openContainerModal() {
      document.getElementById('containerModal').classList.add('show');
      document.getElementById('proxyType').addEventListener('change', (e) => {
        document.getElementById('proxyFields').style.display = e.target.value ? 'block' : 'none';
      });
    }

    function closeContainerModal() {
      document.getElementById('containerModal').classList.remove('show');
    }

    async function createContainer() {
      const proxyType = document.getElementById('proxyType').value;
      let proxy = null;

      if (proxyType) {
        proxy = {
          type: proxyType,
          host: document.getElementById('proxyHost').value,
          port: parseInt(document.getElementById('proxyPort').value)
        };

        const username = document.getElementById('proxyUsername').value;
        const password = document.getElementById('proxyPassword').value;

        if (username) proxy.username = username;
        if (password) proxy.password = password;
      }

      try {
        closeContainerModal();
        const data = await fetchJSON('/dashboard/containers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proxy })
        });

        if (data.containerId) {
          await updateContainers();
          await updateActivity();
        } else {
          alert('Container creation failed: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Container creation failed: ' + err.message);
      }
    }

    async function deleteContainer(containerId) {
      if (!confirm('Delete this container?')) return;

      try {
        await fetchJSON(\`/dashboard/containers/\${containerId}\`, { method: 'DELETE' });
        updateContainers();
        updateActivity();
      } catch (err) {
        alert('Failed to delete container: ' + err.message);
      }
    }

    // Initialize
    checkModuleAvailability();
    updateHealth();
    updateSessions();
    updateContainers();
    updateActivity();

    setInterval(updateHealth, 10000);
    setInterval(updateSessions, 30000);
    setInterval(updateContainers, 30000);
    setInterval(updateActivity, 15000);
  </script>
</body>
</html>`);
});

// Restore sessions into enclave on startup
async function restoreSessions() {
  const sessionIds = Object.keys(sessions.sessions);
  if (sessionIds.length === 0) return;

  console.log(`🔄 Restoring ${sessionIds.length} sessions into enclave...`);

  for (const sessionId of sessionIds) {
    const session = sessions.sessions[sessionId];
    try {
      const { status } = await enclaveRequest('/load-session', {
        method: 'POST',
        body: JSON.stringify({ sessionData: session.sessionData })
      });

      if (status === 200) {
        console.log(`  ✅ Restored session for @${session.sessionData.user?.username}`);
        addActivity(`Restored session for @${session.sessionData.user?.username}`);
      } else {
        console.log(`  ❌ Failed to restore session for @${session.sessionData.user?.username}`);
      }
    } catch (err) {
      console.log(`  ❌ Error restoring session: ${err.message}`);
    }
  }
}

app.listen(DASHBOARD_PORT, async () => {
  console.log(`🚀 Dashboard running on http://localhost:${DASHBOARD_PORT}`);
  console.log(`📡 Enclave API: ${ENCLAVE_URL}`);
  console.log(`💾 Sessions file: ${SESSIONS_FILE}`);

  // Wait a moment for enclave to be ready, then restore sessions
  setTimeout(async () => {
    try {
      await restoreSessions();
    } catch (err) {
      console.log(`⚠️  Could not restore sessions: ${err.message}`);
      console.log(`   Dashboard will continue, sessions can be added via auth.`);
    }
  }, 2000);
});