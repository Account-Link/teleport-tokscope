#!/usr/bin/env node
/**
 * Xordi Nooscope - Algorithmic Transparency Tool
 *
 * A simple web interface for exploring TikTok's recommendation algorithm.
 * Shows what's in your For You feed and provides insights into the content
 * you're being recommended.
 *
 * Works with workbench (single-container) setup using browser automation only.
 * Gracefully supports both logged-out (public timeline) and authenticated sampling.
 *
 * Usage:
 *   node examples/nooscope.js
 *   Then visit: http://localhost:5000
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const BrowserAutomationClient = require('../dist/lib/browser-automation-client');

const app = express();
app.use(express.json());

const PORT = process.env.NOOSCOPE_PORT || 5000;
const CDP_URL = process.env.CDP_URL || 'http://localhost:9223';

// In-memory storage
let sampleHistory = [];
let currentSession = null;

// Load most recent session if available
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
    console.log('ℹ️  No saved session found - will sample logged-out timeline');
    return false;
  } catch (err) {
    console.log('ℹ️  Could not load session - will sample logged-out timeline');
    return false;
  }
}

// Sample timeline using browser automation
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
      videos
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

// Analyze videos for insights
function analyzeVideos(videos) {
  const creators = {};
  const hashtags = {};
  const topics = {};

  videos.forEach(video => {
    // Count creators
    const author = video.author || 'unknown';
    creators[author] = (creators[author] || 0) + 1;

    // Count hashtags
    if (video.challenges) {
      video.challenges.forEach(challenge => {
        const tag = `#${challenge.title}`;
        hashtags[tag] = (hashtags[tag] || 0) + 1;
      });
    }

    // Extract topics from description
    const desc = video.desc || '';
    const words = desc.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    words.forEach(word => {
      if (!word.startsWith('#') && !word.startsWith('@')) {
        topics[word] = (topics[word] || 0) + 1;
      }
    });
  });

  const topCreators = Object.entries(creators)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const topHashtags = Object.entries(hashtags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const topTopics = Object.entries(topics)
    .filter(([_, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const totalViews = videos.reduce((sum, v) => sum + (v.views || 0), 0);
  const totalLikes = videos.reduce((sum, v) => sum + (v.likes || 0), 0);
  const avgDuration = videos.reduce((sum, v) => sum + (v.video?.duration || 0), 0) / videos.length / 1000;

  return {
    totalVideos: videos.length,
    totalViews,
    totalLikes,
    avgDuration: Math.round(avgDuration),
    uniqueCreators: Object.keys(creators).length,
    topCreators,
    topHashtags,
    topTopics
  };
}

// API Routes

app.get('/api/status', (req, res) => {
  res.json({
    authenticated: !!currentSession,
    username: currentSession?.user?.username || null,
    samplesCollected: sampleHistory.length,
    cdpUrl: CDP_URL
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

app.get('/api/history', (req, res) => {
  res.json({ samples: sampleHistory });
});

app.get('/api/latest', (req, res) => {
  if (sampleHistory.length === 0) {
    return res.status(404).json({ error: 'No samples collected yet' });
  }

  const latest = sampleHistory[0];
  const analysis = analyzeVideos(latest.videos);

  res.json({
    sample: latest,
    analysis
  });
});

app.get('/api/insights', (req, res) => {
  if (sampleHistory.length === 0) {
    return res.status(404).json({ error: 'No samples collected yet' });
  }

  const allVideos = sampleHistory.flatMap(s => s.videos);
  const analysis = analyzeVideos(allVideos);

  res.json({
    totalSamples: sampleHistory.length,
    timeRange: {
      earliest: sampleHistory[sampleHistory.length - 1].timestamp,
      latest: sampleHistory[0].timestamp
    },
    analysis
  });
});

// Serve static frontend
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Xordi Nooscope - Algorithmic Transparency</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #fafafa;
      color: #333;
    }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 2rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .subtitle { opacity: 0.9; }
    .container { max-width: 1200px; margin: 2rem auto; padding: 0 1rem; }
    .status-card {
      background: white;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    .status-badge {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 20px;
      font-weight: 600;
      margin-right: 1rem;
    }
    .authenticated { background: #10b981; color: white; }
    .public { background: #f59e0b; color: white; }
    .controls { margin: 2rem 0; }
    button {
      background: #667eea;
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      margin-right: 1rem;
      transition: all 0.2s;
    }
    button:hover { background: #5568d3; transform: translateY(-1px); }
    button:disabled { background: #ccc; cursor: not-allowed; transform: none; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; }
    .card {
      background: white;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    }
    .card h3 { margin-bottom: 1rem; color: #667eea; }
    .stat { font-size: 2rem; font-weight: bold; color: #667eea; }
    .stat-label { font-size: 0.875rem; color: #666; margin-top: 0.25rem; }
    .list { list-style: none; }
    .list li {
      padding: 0.75rem;
      border-bottom: 1px solid #eee;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .list li:last-child { border-bottom: none; }
    .badge {
      background: #667eea;
      color: white;
      padding: 0.25rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .loading { text-align: center; padding: 2rem; color: #666; }
    .spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #667eea;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .video-list { margin-top: 2rem; }
    .video-item {
      background: white;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .video-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.875rem;
      color: #666;
      margin-top: 0.5rem;
    }
    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: #666;
    }
    .empty-state h2 { color: #333; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <header>
    <h1>🔭 Xordi Nooscope</h1>
    <p class="subtitle">Algorithmic Transparency for TikTok</p>
  </header>

  <div class="container">
    <div class="status-card">
      <div id="status-info">
        <div class="loading">
          <div class="spinner"></div>
          Loading status...
        </div>
      </div>
      <div class="controls" id="controls" style="display: none;">
        <button onclick="sampleNow()" id="sample-btn">📱 Sample Timeline</button>
        <button onclick="loadInsights()">📊 Show Insights</button>
      </div>
    </div>

    <div id="content">
      <div class="empty-state">
        <h2>Welcome to the Nooscope</h2>
        <p>Click "Sample Timeline" above to start exploring your TikTok recommendations</p>
      </div>
    </div>
  </div>

  <script>
    let currentStatus = null;

    async function loadStatus() {
      const res = await fetch('/api/status');
      currentStatus = await res.json();

      const badge = currentStatus.authenticated
        ? '<span class="status-badge authenticated">🔐 Authenticated as @' + currentStatus.username + '</span>'
        : '<span class="status-badge public">🌍 Public Timeline</span>';

      const info = currentStatus.authenticated
        ? 'Sampling your personalized For You feed'
        : 'Sampling the public For You feed (login via workbench for personalized feed)';

      document.getElementById('status-info').innerHTML = badge + '<p style="margin-top: 1rem;">' + info + '</p>';
      document.getElementById('controls').style.display = 'block';

      if (currentStatus.samplesCollected > 0) {
        loadLatest();
      }
    }

    async function sampleNow() {
      const btn = document.getElementById('sample-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Sampling...';

      document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div>Sampling timeline (this may take 30-60 seconds)...</div>';

      try {
        const res = await fetch('/api/sample', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ count: 10 })
        });

        const data = await res.json();

        if (data.success) {
          await loadLatest();
        } else {
          document.getElementById('content').innerHTML = '<div class="card"><h3>❌ Error</h3><p>' + data.error + '</p></div>';
        }
      } catch (err) {
        document.getElementById('content').innerHTML = '<div class="card"><h3>❌ Error</h3><p>' + err.message + '</p></div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '📱 Sample Timeline';
      }
    }

    async function loadLatest() {
      const res = await fetch('/api/latest');
      const data = await res.json();

      const analysis = data.analysis;
      const sample = data.sample;

      document.getElementById('content').innerHTML = \`
        <h2 style="margin-bottom: 1.5rem;">Latest Sample: \${new Date(sample.timestamp).toLocaleString()}</h2>

        <div class="grid">
          <div class="card">
            <h3>📊 Overview</h3>
            <div class="stat">\${analysis.totalVideos}</div>
            <div class="stat-label">Videos Sampled</div>
            <div style="margin-top: 1rem;">
              <div><strong>\${analysis.uniqueCreators}</strong> unique creators</div>
              <div><strong>\${Math.round(analysis.avgDuration)}s</strong> avg duration</div>
            </div>
          </div>

          <div class="card">
            <h3>👥 Top Creators</h3>
            <ul class="list">
              \${analysis.topCreators.slice(0, 5).map(([creator, count]) =>
                \`<li><span>@\${creator}</span><span class="badge">\${count}</span></li>\`
              ).join('')}
            </ul>
          </div>

          <div class="card">
            <h3>#️⃣ Top Hashtags</h3>
            <ul class="list">
              \${analysis.topHashtags.slice(0, 5).map(([tag, count]) =>
                \`<li><span>\${tag}</span><span class="badge">\${count}</span></li>\`
              ).join('')}
            </ul>
          </div>
        </div>

        <div class="video-list">
          <h3 style="margin-bottom: 1rem;">🎥 Videos</h3>
          \${sample.videos.map(video => \`
            <div class="video-item">
              <div><strong>@\${video.author}</strong></div>
              <div>\${video.desc || 'No description'}</div>
              <div class="video-meta">
                <span>❤️ \${(video.likes || 0).toLocaleString()} likes</span>
                <span>💬 \${(video.comments || 0).toLocaleString()} comments</span>
                <span>👁️ \${(video.views || 0).toLocaleString()} views</span>
              </div>
              <a href="\${video.webUrl}" target="_blank" style="font-size: 0.875rem; color: #667eea;">View on TikTok →</a>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    async function loadInsights() {
      const res = await fetch('/api/insights');
      if (res.status === 404) {
        alert('No samples collected yet. Click "Sample Timeline" first.');
        return;
      }

      const data = await res.json();
      const analysis = data.analysis;

      document.getElementById('content').innerHTML = \`
        <h2 style="margin-bottom: 1.5rem;">All-Time Insights (\${data.totalSamples} samples)</h2>

        <div class="grid">
          <div class="card">
            <h3>📊 Overall Stats</h3>
            <div class="stat">\${analysis.totalVideos}</div>
            <div class="stat-label">Total Videos</div>
            <div style="margin-top: 1rem;">
              <div><strong>\${analysis.uniqueCreators}</strong> unique creators</div>
              <div><strong>\${analysis.topHashtags.length}</strong> unique hashtags</div>
            </div>
          </div>

          <div class="card">
            <h3>👥 Most Seen Creators</h3>
            <ul class="list">
              \${analysis.topCreators.map(([creator, count]) =>
                \`<li><span>@\${creator}</span><span class="badge">\${count}</span></li>\`
              ).join('')}
            </ul>
          </div>

          <div class="card">
            <h3>#️⃣ Most Common Hashtags</h3>
            <ul class="list">
              \${analysis.topHashtags.map(([tag, count]) =>
                \`<li><span>\${tag}</span><span class="badge">\${count}</span></li>\`
              ).join('')}
            </ul>
          </div>

          <div class="card">
            <h3>📝 Common Topics</h3>
            <ul class="list">
              \${analysis.topTopics.map(([topic, count]) =>
                \`<li><span>\${topic}</span><span class="badge">\${count}</span></li>\`
              ).join('')}
            </ul>
          </div>
        </div>
      \`;
    }

    loadStatus();
  </script>
</body>
</html>
  `);
});

// Start server
async function start() {
  await loadRecentSession();

  app.listen(PORT, () => {
    console.log('🔭 Xordi Nooscope starting...');
    console.log('');
    console.log(`   🌐 Open: http://localhost:${PORT}`);
    console.log(`   📱 Mode: ${currentSession ? 'Authenticated (@' + currentSession.user.username + ')' : 'Public timeline'}`);
    console.log('');
    console.log('💡 Tip: Authenticate via workbench.js to sample your personalized feed');
    console.log('   node workbench.js auth');
    console.log('');
  });
}

start().catch(console.error);
