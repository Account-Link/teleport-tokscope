#!/usr/bin/env node

/**
 * Script to launch docker-compose files in dstack using Phala Cloud CLI
 * Usage: ./launch-dstack.js [compose-file] [options]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_NODE_ID = 12;
const DEFAULT_KMS_ID = 'kms-base-prod7';
const DEFAULT_COMPOSE = './docker-compose-audit.yml';

function showUsage() {
  console.log(`
Usage: node launch-dstack.js [compose-file] [options]

Arguments:
  compose-file           Docker compose file to deploy (default: ${DEFAULT_COMPOSE})

Options:
  --node-id <id>         Node ID to deploy to (default: ${DEFAULT_NODE_ID})
  --kms-id <id>          KMS ID to use (default: ${DEFAULT_KMS_ID})
  --rpc-url <url>        RPC URL for blockchain
  --private-key <key>    Private key for on-chain KMS
  --name <name>          Custom name for the deployment
  --dry-run              Show what would be deployed without deploying
  --help                 Show this help

Environment Variables:
  RPC_URL               Default RPC URL
  PRIVATEKEY            Default private key
  PHALA_CLOUD_API_KEY   Required API key for Phala Cloud

Examples:
  node launch-dstack.js                                    # Deploy docker-compose-audit.yml
  node launch-dstack.js docker-compose.yml                 # Deploy specific compose file
  node launch-dstack.js --dry-run                          # Preview deployment
  node launch-dstack.js --name my-audit-build              # Custom deployment name
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    composeFile: DEFAULT_COMPOSE,
    nodeId: DEFAULT_NODE_ID,
    kmsId: DEFAULT_KMS_ID,
    rpcUrl: process.env.RPC_URL,
    privateKey: process.env.PRIVATEKEY,
    name: null,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help') {
      config.help = true;
    } else if (arg === '--dry-run') {
      config.dryRun = true;
    } else if (arg === '--node-id') {
      config.nodeId = parseInt(args[++i]);
    } else if (arg === '--kms-id') {
      config.kmsId = args[++i];
    } else if (arg === '--rpc-url') {
      config.rpcUrl = args[++i];
    } else if (arg === '--private-key') {
      config.privateKey = args[++i];
    } else if (arg === '--name') {
      config.name = args[++i];
    } else if (!arg.startsWith('--')) {
      config.composeFile = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return config;
}

function validateConfig(config) {
  if (!process.env.PHALA_CLOUD_API_KEY) {
    console.error('Error: PHALA_CLOUD_API_KEY environment variable is required');
    process.exit(1);
  }

  if (!fs.existsSync(config.composeFile)) {
    console.error(`Error: Compose file ${config.composeFile} not found`);
    process.exit(1);
  }

  if (!config.dryRun && !config.help) {
    if (!config.rpcUrl) {
      console.error('Error: --rpc-url is required or set RPC_URL environment variable');
      process.exit(1);
    }

    if (!config.privateKey) {
      console.error('Error: --private-key is required or set PRIVATEKEY environment variable');
      process.exit(1);
    }
  }
}

function deployToPhala(config) {
  const composePath = path.resolve(config.composeFile);

  console.log(`Deploying ${config.composeFile} to dstack...`);
  console.log(`  Compose file: ${composePath}`);
  console.log(`  Node ID: ${config.nodeId}`);
  console.log(`  KMS ID: ${config.kmsId}`);

  if (config.dryRun) {
    console.log('  DRY RUN - would execute:');
    console.log(`  phala deploy --node-id ${config.nodeId} --kms-id ${config.kmsId} ${composePath} --rpc-url ${config.rpcUrl} --private-key ${config.privateKey}${config.name ? ' --name ' + config.name : ''}`);
    return;
  }

  const cmd = [
    'phala', 'deploy',
    '--node-id', config.nodeId.toString(),
    '--kms-id', config.kmsId,
    composePath,
    '--rpc-url', config.rpcUrl,
    '--private-key', config.privateKey
  ];

  if (config.name) {
    cmd.push('--name', config.name);
  }

  console.log(`Executing: ${cmd.join(' ')}`);

  try {
    execSync(cmd.join(' '), {
      stdio: 'inherit',
      env: { ...process.env, PHALA_CLOUD_API_KEY: process.env.PHALA_CLOUD_API_KEY }
    });
    console.log('Deployment completed successfully!');
  } catch (error) {
    console.error('Deployment failed:', error.message);
    process.exit(1);
  }
}

function main() {
  const config = parseArgs();

  if (config.help) {
    showUsage();
    return;
  }

  validateConfig(config);

  if (!config.name) {
    const baseName = path.basename(config.composeFile, path.extname(config.composeFile));
    config.name = `${baseName}-${Date.now()}`;
  }

  deployToPhala(config);
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, validateConfig };