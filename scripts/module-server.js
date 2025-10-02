#!/usr/bin/env node
/**
 * Local Module Development Server
 *
 * Serves proprietary modules on localhost:8080 for rapid iteration during development.
 * This enables quick testing without rebuilding Docker containers.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const PORT = 8080;
const MODULES_DIR = path.join(__dirname, '..', 'proprietary-modules');

const app = express();

// Enable CORS for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Serve modules with proper content type
app.use('/modules', express.static(MODULES_DIR, {
  setHeaders: (res, path) => {
    if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// List available modules
app.get('/', (req, res) => {
  try {
    const files = fs.readdirSync(MODULES_DIR)
      .filter(file => file.endsWith('.js'))
      .map(file => ({
        name: file,
        url: `http://localhost:${PORT}/modules/${file}`,
        size: fs.statSync(path.join(MODULES_DIR, file)).size
      }));

    res.json({
      message: 'Xordi Module Development Server',
      modules: files,
      total: files.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', port: PORT, modulesDir: MODULES_DIR });
});

app.listen(PORT, () => {
  console.log(`\n📦 Module Development Server started on http://localhost:${PORT}`);
  console.log(`📁 Serving modules from: ${MODULES_DIR}`);

  try {
    const files = fs.readdirSync(MODULES_DIR).filter(f => f.endsWith('.js'));
    console.log(`\n🔧 Available modules for development:`);
    files.forEach(file => {
      console.log(`   • ${file}: http://localhost:${PORT}/modules/${file}`);
    });

    console.log(`\n💡 Usage:`);
    console.log(`   • Edit modules in: ${MODULES_DIR}`);
    console.log(`   • Changes are served immediately (no restart needed)`);
    console.log(`   • Set WEB_AUTH_MODULE_URL="http://localhost:${PORT}/modules/web-auth.js"`);
    console.log(`   • Set MOBILE_AUTH_MODULE_URL="http://localhost:${PORT}/modules/mobile-auth.js"`);
  } catch (error) {
    console.log(`   ⚠️  No modules directory found at ${MODULES_DIR}`);
  }
});