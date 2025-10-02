#!/usr/bin/env node
/**
 * Teleport TikTok Nooscope Web - TikTok Data Collection Dashboard
 *
 * A web interface for sampling TikTok content with a live browser viewer.
 * Supports both logged-out and authenticated sampling for analyzing content
 * recommendation patterns, meme propagation, and sentiment shifts.
 *
 * Usage:
 *   node examples/nooscope-web.js
 *   Then visit: http://localhost:8001
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const BrowserAutomationClient = require('../dist/lib/browser-automation-client');
const QRExtractor = require('../dist/lib/qr-extractor');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8001;
const NEKO_URL = process.env.NEKO_URL || 'http://localhost:8080';
const CDP_URL = process.env.CDP_URL || 'http://localhost:9223';

// In-memory storage
let sampleHistory = [];
let currentSession = null;
let authState = null; // { browser, page, qrData, status }

// Load most recent session
async function loadRecentSession() {
  try {
    const outputDir = path.join(__dirname, '..', 'output');
    const files = await fs.readdir(outputDir);
    const sessionFiles = files
      .filter(f => f.startsWith('tiktok-auth-') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(outputDir, f) }))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (sessionFiles.length > 0) {
      const sessionContent = await fs.readFile(sessionFiles[0].path, 'utf8');
      currentSession = JSON.parse(sessionContent);
      console.log(`📂 Loaded session for @${currentSession.user?.username || 'unknown'}`);
      return true;
    }
    console.log('ℹ️  No saved session - will sample logged-out timeline');
    return false;
  } catch (err) {
    console.log('ℹ️  Could not load session - will sample logged-out timeline');
    return false;
  }
}

// Sample FYP timeline
async function sampleTimeline(count = 10) {
  const isAuthenticated = !!currentSession;
  const username = currentSession?.user?.username || 'public';

  console.log(`📱 Sampling ${count} videos (${isAuthenticated ? 'authenticated' : 'logged-out'})...`);

  const browserClient = new BrowserAutomationClient(currentSession, {
    reuseContainer: true,
    cdpUrl: CDP_URL
  });

  try {
    await browserClient.initialize();
    const videos = await browserClient.sampleForYouFeed(count);
    await browserClient.cleanup();

    const sample = {
      timestamp: new Date().toISOString(),
      username,
      authenticated: isAuthenticated,
      count: videos.length,
      videos,
      type: 'foryou'
    };

    sampleHistory.unshift(sample);
    if (sampleHistory.length > 20) sampleHistory.pop();

    console.log(`✅ Sampled ${videos.length} videos`);
    return sample;

  } catch (error) {
    console.error('❌ Sampling failed:', error.message);
    await browserClient.cleanup();
    throw error;
  }
}

// Sample watch history
async function sampleWatchHistory(count = 10) {
  if (!currentSession) {
    throw new Error('Watch history requires authentication');
  }

  const username = currentSession?.user?.username || 'authenticated';
  console.log(`📜 Sampling ${count} watch history videos...`);

  const browserClient = new BrowserAutomationClient(currentSession, {
    reuseContainer: true,
    cdpUrl: CDP_URL
  });

  try {
    await browserClient.initialize();
    const videos = await browserClient.sampleWatchHistory(count);
    await browserClient.cleanup();

    const sample = {
      timestamp: new Date().toISOString(),
      username,
      authenticated: true,
      count: videos.length,
      videos,
      type: 'watch-history'
    };

    sampleHistory.unshift(sample);
    if (sampleHistory.length > 20) sampleHistory.pop();

    console.log(`✅ Sampled ${videos.length} watch history videos`);
    return sample;

  } catch (error) {
    console.error('❌ Watch history sampling failed:', error.message);
    await browserClient.cleanup();
    throw error;
  }
}

// Analyze videos
function analyzeVideos(videos) {
  const creators = {};
  const hashtags = {};

  videos.forEach(video => {
    const author = video.author || 'unknown';
    creators[author] = (creators[author] || 0) + 1;

    if (video.challenges) {
      video.challenges.forEach(challenge => {
        const tag = `#${challenge.title}`;
        hashtags[tag] = (hashtags[tag] || 0) + 1;
      });
    }
  });

  const topCreators = Object.entries(creators)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const topHashtags = Object.entries(hashtags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return {
    totalVideos: videos.length,
    uniqueCreators: Object.keys(creators).length,
    topCreators,
    topHashtags
  };
}

// API Routes

app.get('/api/status', (req, res) => {
  res.json({
    authenticated: !!currentSession,
    username: currentSession?.user?.username || null,
    samplesCollected: sampleHistory.length
  });
});

app.post('/api/sample', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const sample = await sampleTimeline(count);
    res.json({ success: true, sample });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/sample-history', async (req, res) => {
  const { count = 10 } = req.body;
  try {
    const sample = await sampleWatchHistory(count);
    res.json({ success: true, sample });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/samples', (req, res) => {
  const samplesWithAnalysis = sampleHistory.map(sample => ({
    ...sample,
    analysis: analyzeVideos(sample.videos)
  }));
  res.json({ samples: samplesWithAnalysis });
});

app.get('/api/latest', (req, res) => {
  if (sampleHistory.length === 0) {
    return res.status(404).json({ error: 'No samples collected yet' });
  }
  const latest = sampleHistory[0];
  res.json({ sample: latest, analysis: analyzeVideos(latest.videos) });
});

// Auth endpoints
app.post('/api/auth/start', async (req, res) => {
  try {
    if (authState) {
      return res.json({ status: authState.status, qrData: authState.qrData });
    }

    console.log('🔐 Starting authentication...');

    // Connect to browser
    const browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    const page = contexts[0].pages()[0] || await contexts[0].newPage();

    // Navigate to QR login
    await page.goto('https://www.tiktok.com/login/qrcode', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    // Extract QR code
    const qrData = await QRExtractor.extractQRCodeFromPage(page);
    if (!qrData) {
      throw new Error('Could not extract QR code');
    }

    authState = {
      browser,
      page,
      qrData,
      status: 'awaiting_scan',
      startTime: Date.now()
    };

    console.log('✅ QR code ready');
    res.json({ status: 'awaiting_scan', qrData });

  } catch (error) {
    console.error('❌ Auth start failed:', error.message);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.get('/api/auth/status', async (req, res) => {
  if (!authState) {
    return res.json({ status: 'not_started' });
  }

  try {
    // Check if login completed by looking for cookies
    const cookies = await authState.page.context().cookies();
    const hasSessionToken = cookies.some(c => c.name === 'sessionid' || c.name === 'sid_tt');

    if (hasSessionToken && authState.status === 'awaiting_scan') {
      console.log('✅ Authentication successful!');
      authState.status = 'completed';

      // Extract auth data using BrowserAutomationClient
      const sessionData = await BrowserAutomationClient.extractAuthData(authState.page);

      const outputDir = path.join(__dirname, '..', 'output');
      await fs.mkdir(outputDir, { recursive: true });
      const filename = `tiktok-auth-${new Date().toISOString().replace(/[:.]/g, '-').split('.')[0]}.json`;
      await fs.writeFile(
        path.join(outputDir, filename),
        JSON.stringify(sessionData, null, 2)
      );

      console.log(`💾 Session saved: ${filename}`);

      // Reload session
      await loadRecentSession();

      // Cleanup
      setTimeout(async () => {
        if (authState?.browser) {
          await authState.browser.close().catch(() => {});
        }
        authState = null;
      }, 1000);
    }

    res.json({ status: authState.status, qrData: authState.qrData });

  } catch (error) {
    console.error('Auth status check failed:', error.message);
    res.json({ status: authState.status, qrData: authState.qrData });
  }
});

// Serve viewer client
app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer-client.html'));
});

// Main UI
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Nooscope Web</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; }
    .header { background: #1a1a1a; color: white; padding: 1rem 2rem; }
    .header h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .header p { font-size: 0.9rem; opacity: 0.8; }
    .container { display: flex; gap: 1rem; height: calc(100vh - 80px); padding: 1rem; }
    .sidebar { width: 100%; max-width: 800px; margin: 0 auto; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; transition: all 0.3s ease; }
    .container.viewer-active .sidebar { width: 400px; max-width: 400px; margin: 0; flex-shrink: 0; }
    .viewer-panel { flex: 1; background: #000; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.2); display: none; transition: all 0.3s ease; }
    .viewer-panel.show { display: block; }
    .viewer-frame { width: 100%; height: 100%; border: none; }
    .card { background: white; border-radius: 8px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #1a1a1a; }
    .status-badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 4px; font-size: 0.85rem; font-weight: 500; }
    .status-badge.auth { background: #d1fae5; color: #065f46; }
    .status-badge.public { background: #fee2e2; color: #991b1b; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-size: 0.9rem; width: 100%; margin-top: 0.5rem; }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #9ca3af; cursor: not-allowed; }
    button.secondary { background: #6b7280; }
    button.secondary:hover { background: #4b5563; }
    .sample-item { border-left: 3px solid #2563eb; padding: 0.75rem; margin-bottom: 0.75rem; background: #f9fafb; border-radius: 4px; }
    .sample-time { font-size: 0.85rem; color: #6b7280; margin-bottom: 0.25rem; }
    .sample-stats { font-size: 0.9rem; color: #374151; }
    .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000; }
    .modal.show { display: flex; }
    .modal-content { background: white; border-radius: 8px; padding: 2rem; max-width: 500px; width: 90%; }
    .qr-container { text-align: center; margin: 1rem 0; }
    .qr-container img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 4px; }
    @media (max-width: 1200px) {
      .container { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
      .sidebar { max-height: 400px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔭 Teleport TikTok Nooscope</h1>
    <p>TikTok Data Collection Dashboard</p>
  </div>

  <div class="container">
    <div class="sidebar">
      <div class="card">
        <h2>Status</h2>
        <div id="statusInfo">Loading...</div>
        <button onclick="startAuth()">📱 Login with QR Code</button>
      </div>

      <div class="card">
        <h2>Browser Viewer</h2>
        <p style="font-size: 0.9rem; color: #6b7280; margin-bottom: 1rem;">
          Watch live browser activity
        </p>
        <button onclick="toggleViewer()" id="viewerBtn">👁️ Show Viewer</button>
      </div>

      <div class="card">
        <h2>Sample Timeline</h2>
        <p style="font-size: 0.9rem; color: #6b7280; margin-bottom: 1rem;">
          Collect videos from the For You Page
        </p>
        <button onclick="sampleNow()" id="sampleBtn">🎬 Sample 10 Videos</button>
        <button onclick="sampleHistory()" id="historyBtn">📜 Sample Watch History</button>
      </div>

      <div class="card">
        <h2>Recent Samples</h2>
        <div id="samplesList">No samples yet</div>
      </div>
    </div>

    <div class="viewer-panel" id="viewerPanel">
      <iframe class="viewer-frame" id="viewerFrame"></iframe>
    </div>
  </div>

  <div class="modal" id="authModal">
    <div class="modal-content">
      <h2>Scan QR Code</h2>
      <div class="qr-container">
        <img id="qrImage" src="" alt="QR Code" style="display:none">
        <div id="qrStatus">Starting authentication...</div>
      </div>
      <button class="secondary" onclick="closeAuthModal()">Cancel</button>
    </div>
  </div>

  <script>
    let authCheckInterval = null;

    function toggleViewer() {
      const container = document.querySelector('.container');
      const panel = document.getElementById('viewerPanel');
      const btn = document.getElementById('viewerBtn');
      const frame = document.getElementById('viewerFrame');

      if (panel.classList.contains('show')) {
        // Dispose iframe to close WebRTC connection
        frame.src = '';
        panel.classList.remove('show');
        container.classList.remove('viewer-active');
        btn.textContent = '👁️ Show Viewer';
      } else {
        // Load iframe
        frame.src = '/viewer?neko=${encodeURIComponent(NEKO_URL)}';
        panel.classList.add('show');
        container.classList.add('viewer-active');
        btn.textContent = '✖️ Hide Viewer';
      }
    }

    async function updateStatus() {
      const res = await fetch('/api/status');
      const status = await res.json();

      const badge = status.authenticated
        ? \`<span class="status-badge auth">🔐 @\${status.username || 'authenticated'}</span>\`
        : '<span class="status-badge public">👤 Logged Out</span>';

      document.getElementById('statusInfo').innerHTML = \`
        <div style="margin-bottom: 0.5rem;">\${badge}</div>
        <div style="font-size: 0.9rem; color: #6b7280;">Samples: \${status.samplesCollected}</div>
      \`;
    }

    async function updateSamples() {
      const res = await fetch('/api/samples');
      const { samples } = await res.json();

      if (samples.length === 0) {
        document.getElementById('samplesList').innerHTML = '<div style="color: #6b7280; font-size: 0.9rem;">No samples yet</div>';
        return;
      }

      document.getElementById('samplesList').innerHTML = samples.slice(0, 3).map(s => \`
        <div class="sample-item">
          <div class="sample-time">\${new Date(s.timestamp).toLocaleString()}</div>
          <div class="sample-stats" style="margin-bottom: 0.5rem;">
            \${s.type === 'watch-history' ? '📜' : '🎬'} <strong>\${s.count}</strong> videos · <strong>\${s.analysis.uniqueCreators}</strong> creators
          </div>
          <details style="font-size: 0.85rem;">
            <summary style="cursor: pointer; color: #2563eb;">View videos</summary>
            <div style="margin-top: 0.5rem; max-height: 200px; overflow-y: auto;">
              \${s.videos.slice(0, 10).map(v => \`
                <div style="margin: 0.5rem 0; padding: 0.5rem; background: white; border-radius: 4px;">
                  <div style="font-weight: 500;">@\${v.author}</div>
                  <div style="color: #6b7280; margin: 0.25rem 0;">\${v.description.substring(0, 100)}\${v.description.length > 100 ? '...' : ''}</div>
                  <a href="\${v.url}" target="_blank" style="color: #2563eb; text-decoration: none; font-size: 0.8rem;">View on TikTok →</a>
                </div>
              \`).join('')}
            </div>
          </details>
        </div>
      \`).join('');
    }

    async function sampleNow() {
      const btn = document.getElementById('sampleBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Sampling...';

      try {
        const res = await fetch('/api/sample', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          btn.textContent = '✅ Sampled!';
          await updateSamples();
          await updateStatus();
          setTimeout(() => {
            btn.textContent = '🎬 Sample 10 Videos';
            btn.disabled = false;
          }, 2000);
        } else {
          throw new Error(data.error);
        }
      } catch (err) {
        btn.textContent = '❌ Failed';
        alert('Sampling failed: ' + err.message);
        setTimeout(() => {
          btn.textContent = '🎬 Sample 10 Videos';
          btn.disabled = false;
        }, 2000);
      }
    }

    async function sampleHistory() {
      const btn = document.getElementById('historyBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Sampling...';

      try {
        const res = await fetch('/api/sample-history', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
          btn.textContent = '✅ Sampled!';
          await updateSamples();
          await updateStatus();
          setTimeout(() => {
            btn.textContent = '📜 Sample Watch History';
            btn.disabled = false;
          }, 2000);
        } else {
          throw new Error(data.error);
        }
      } catch (err) {
        btn.textContent = '❌ Failed';
        alert('Watch history sampling failed: ' + err.message);
        setTimeout(() => {
          btn.textContent = '📜 Sample Watch History';
          btn.disabled = false;
        }, 2000);
      }
    }

    async function startAuth() {
      document.getElementById('authModal').classList.add('show');
      document.getElementById('qrImage').style.display = 'none';
      document.getElementById('qrStatus').textContent = 'Starting authentication...';

      try {
        const res = await fetch('/api/auth/start', { method: 'POST' });
        const data = await res.json();

        if (data.status === 'awaiting_scan' && data.qrData) {
          document.getElementById('qrImage').src = data.qrData;
          document.getElementById('qrImage').style.display = 'block';
          document.getElementById('qrStatus').textContent = 'Scan with TikTok app';
          checkAuthStatus();
        } else {
          throw new Error('Failed to start auth');
        }
      } catch (err) {
        document.getElementById('qrStatus').textContent = 'Failed: ' + err.message;
      }
    }

    async function checkAuthStatus() {
      if (authCheckInterval) clearInterval(authCheckInterval);

      authCheckInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/auth/status');
          const data = await res.json();

          if (data.status === 'completed') {
            document.getElementById('qrStatus').textContent = '✅ Authentication successful!';
            clearInterval(authCheckInterval);
            setTimeout(() => {
              closeAuthModal();
              updateStatus();
            }, 1500);
          } else if (data.status === 'error') {
            document.getElementById('qrStatus').textContent = '❌ Authentication failed';
            clearInterval(authCheckInterval);
          }
        } catch (err) {
          console.error('Auth check failed:', err);
        }
      }, 1000);
    }

    function closeAuthModal() {
      document.getElementById('authModal').classList.remove('show');
      if (authCheckInterval) {
        clearInterval(authCheckInterval);
        authCheckInterval = null;
      }
    }

    // Initialize
    updateStatus();
    updateSamples();
    setInterval(updateStatus, 5000);
  </script>
</body>
</html>`);
});

// Initialize
loadRecentSession().then(() => {
  app.listen(PORT, () => {
    console.log(`🔭 TikTok Nooscope running on http://localhost:${PORT}`);
    console.log(`📡 Neko URL: ${NEKO_URL}`);
    console.log(`🤖 CDP URL: ${CDP_URL}`);
  });
});
