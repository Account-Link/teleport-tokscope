#!/usr/bin/env node
const fs = require('fs');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN environment variable required');
  console.error('Create a token with gist scope at: https://github.com/settings/tokens');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node publish-module-gist.js <module-path> <module-id> [description]');
  console.error('Example: node publish-module-gist.js private-modules/web-auth.js web-auth-v1 "TikTok web auth module"');
  process.exit(1);
}

const [modulePath, moduleId, description] = args;

if (!fs.existsSync(modulePath)) {
  console.error(`❌ Module file not found: ${modulePath}`);
  process.exit(1);
}

async function publishModule() {
  const octokit = new Octokit({ auth: GITHUB_TOKEN });

  console.log(`📖 Reading module: ${modulePath}`);
  const source = fs.readFileSync(modulePath, 'utf-8');

  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');

  const modulePackage = {
    moduleId,
    source,
    metadata: {
      version: '1.0.0',
      author: 'xordi',
      description: description || `Module: ${moduleId}`,
      timestamp: new Date().toISOString(),
      sourceHash
    }
  };

  console.log(`📦 Creating gist for module: ${moduleId}`);
  const response = await octokit.rest.gists.create({
    description: description || `Module: ${moduleId}`,
    public: false,
    files: {
      [`${moduleId}.json`]: {
        content: JSON.stringify(modulePackage, null, 2)
      }
    }
  });

  const rawUrl = response.data.files[`${moduleId}.json`].raw_url;
  const gistUrl = response.data.html_url;

  console.log('✅ Module published successfully!');
  console.log('');
  console.log('Gist URL (browser):');
  console.log(`  ${gistUrl}`);
  console.log('');
  console.log('Raw URL (for enclave):');
  console.log(`  ${rawUrl}`);
  console.log('');
  console.log('Add to .env:');
  console.log(`  ${moduleId.toUpperCase().replace(/-/g, '_')}_MODULE_URL="${rawUrl}"`);
}

publishModule().catch(error => {
  console.error('❌ Failed to publish module:', error.message);
  process.exit(1);
});
