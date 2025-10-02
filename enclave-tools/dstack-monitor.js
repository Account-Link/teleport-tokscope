#!/usr/bin/env node

/**
 * Script to monitor and interact with dstack deployments
 * Usage: ./dstack-monitor.js [command] [options]
 */

const { execSync } = require('child_process');
const https = require('https');

function showUsage() {
  console.log(`
Usage: node dstack-monitor.js [command] [options]

Commands:
  list                           List all CVMs
  info <app-id>                  Show CVM information
  logs <app-id> <service>        Show service logs
  status <app-id>                Check node status
  url <app-id> [port] [suffix]   Generate gateway URL
  test <app-id>                  Test connectivity to services

Options:
  --tail <n>                     Number of log lines (default: 20)
  --follow                       Follow logs continuously
  --gateway <domain>             Override gateway domain
  --help                         Show this help

Examples:
  node dstack-monitor.js list
  node dstack-monitor.js info c651380e78f32f161efcaaaba74f0dca208a980c
  node dstack-monitor.js logs c651380e78f32f161efcaaaba74f0dca208a980c tokscope-enclave
  node dstack-monitor.js status c651380e78f32f161efcaaaba74f0dca208a980c
  node dstack-monitor.js url c651380e78f32f161efcaaaba74f0dca208a980c 3000
  node dstack-monitor.js test c651380e78f32f161efcaaaba74f0dca208a980c --gateway dstack-base-prod7.phala.network
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    command: args[0],
    appId: args[1],
    service: args[2],
    port: args[2],
    suffix: args[3],
    tail: 20,
    follow: false,
    gateway: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      config.help = true;
    } else if (arg === '--follow') {
      config.follow = true;
    } else if (arg === '--tail') {
      config.tail = parseInt(args[++i]);
    } else if (arg === '--gateway') {
      config.gateway = args[++i];
    }
  }

  return config;
}

function listCVMs() {
  try {
    const output = execSync('phala cvms list', {
      encoding: 'utf8',
      env: { ...process.env }
    });
    console.log(output);
  } catch (error) {
    console.error('Failed to list CVMs:', error.message);
    process.exit(1);
  }
}

function getCVMInfo(appId) {
  try {
    const output = execSync(`phala cvms info ${appId}`, {
      encoding: 'utf8',
      env: { ...process.env }
    });
    console.log(output);
  } catch (error) {
    console.error('Failed to get CVM info:', error.message);
    process.exit(1);
  }
}

function detectGateway(appId) {
  try {
    const output = execSync('phala cvms list', { encoding: 'utf8', env: { ...process.env } });
    const lines = output.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(appId)) {
        // Look for Node Info URL in the next few lines
        for (let j = i; j < i + 10 && j < lines.length; j++) {
          const match = lines[j].match(/https:\/\/[^-]+-8090\.(dstack-[^.]+\.phala\.network)/);
          if (match) {
            return match[1];
          }
        }
      }
    }

    // Fallback
    return 'dstack-base-prod7.phala.network';
  } catch (error) {
    console.error('Failed to detect gateway:', error.message);
    return 'dstack-base-prod7.phala.network';
  }
}

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode, data }));
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function getServiceLogs(appId, service, config) {
  const gateway = config.gateway || detectGateway(appId);
  const params = new URLSearchParams();

  params.append('text', '');
  params.append('bare', '');
  params.append('timestamps', '');

  if (config.tail) params.append('tail', config.tail);
  if (config.follow) params.append('follow', '');

  const url = `https://${appId}-8090.${gateway}/logs/${service}?${params}`;

  console.log(`Fetching logs from: ${url}`);

  try {
    const response = await makeRequest(url);
    if (response.status === 200) {
      console.log(response.data);
    } else {
      console.error(`HTTP ${response.status}: ${response.data}`);
    }
  } catch (error) {
    console.error('Failed to fetch logs:', error.message);
  }
}

async function checkNodeStatus(appId, config) {
  const gateway = config.gateway || detectGateway(appId);
  const url = `https://${appId}-8090.${gateway}/`;

  console.log(`Checking node status: ${url}`);

  try {
    const response = await makeRequest(url);
    if (response.status === 200) {
      // Extract container info from HTML
      const containerMatch = response.data.match(/<tbody>([\s\S]*?)<\/tbody>/);
      if (containerMatch) {
        const tbody = containerMatch[1];
        const rows = tbody.match(/<tr>([\s\S]*?)<\/tr>/g);

        if (rows && rows.length > 0) {
          console.log('✅ Node is running with containers:');
          rows.forEach(row => {
            const nameMatch = row.match(/<td>([^<]+)<\/td>/);
            const statusMatch = row.match(/<td>([^<]*(?:running|stopped|failed)[^<]*)<\/td>/i);
            if (nameMatch && statusMatch) {
              console.log(`  - ${nameMatch[1]}: ${statusMatch[1]}`);
            }
          });
        } else {
          console.log('⚠️  Node is running but no containers deployed');
        }
      } else {
        console.log('⚠️  Node is running but container info not found');
      }
    } else {
      console.log(`❌ Node not responding: HTTP ${response.status}`);
    }
  } catch (error) {
    console.log(`❌ Node not reachable: ${error.message}`);
  }
}

function generateURL(appId, port, suffix, config) {
  const gateway = config.gateway || detectGateway(appId);
  const portPart = port ? `-${port}` : '';
  const suffixPart = suffix || '';

  const url = `https://${appId}${portPart}${suffixPart}.${gateway}/`;
  console.log(url);
}

async function testConnectivity(appId, config) {
  const gateway = config.gateway || detectGateway(appId);

  console.log(`Testing connectivity for ${appId} on ${gateway}...\n`);

  // Test node info
  console.log('🔍 Testing node info (port 8090)...');
  await checkNodeStatus(appId, config);

  console.log('\n🔍 Testing main application (port 3000)...');
  const appUrl = `https://${appId}-3000.${gateway}/`;
  try {
    const response = await makeRequest(appUrl);
    console.log(`✅ App responding: HTTP ${response.status}`);
  } catch (error) {
    console.log(`❌ App not reachable: ${error.message}`);
  }

  console.log('\n🔗 Useful URLs:');
  console.log(`  Node Info: https://${appId}-8090.${gateway}/`);
  console.log(`  Main App:  https://${appId}-3000.${gateway}/`);
  console.log(`  Logs:      Use 'logs' command with service name`);
}

function main() {
  const config = parseArgs();

  if (config.help || !config.command) {
    showUsage();
    return;
  }

  switch (config.command) {
    case 'list':
      listCVMs();
      break;

    case 'info':
      if (!config.appId) {
        console.error('Error: app-id required');
        process.exit(1);
      }
      getCVMInfo(config.appId);
      break;

    case 'logs':
      if (!config.appId || !config.service) {
        console.error('Error: app-id and service required');
        process.exit(1);
      }
      getServiceLogs(config.appId, config.service, config);
      break;

    case 'status':
      if (!config.appId) {
        console.error('Error: app-id required');
        process.exit(1);
      }
      checkNodeStatus(config.appId, config);
      break;

    case 'url':
      if (!config.appId) {
        console.error('Error: app-id required');
        process.exit(1);
      }
      generateURL(config.appId, config.port, config.suffix, config);
      break;

    case 'test':
      if (!config.appId) {
        console.error('Error: app-id required');
        process.exit(1);
      }
      testConnectivity(config.appId, config);
      break;

    default:
      console.error(`Unknown command: ${config.command}`);
      showUsage();
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, detectGateway, makeRequest };