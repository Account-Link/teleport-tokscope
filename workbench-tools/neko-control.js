#!/usr/bin/env node

/**
 * Neko Control - Control neko broadcast service in dev container
 *
 * Safe wrapper around supervisorctl for managing neko service
 */

const { execSync } = require('child_process');

class NekoControl {
  constructor(options = {}) {
    this.containerName = options.containerName || 'simple-auth-container';
    this.timeout = options.timeout || 10000;
  }

  async execInContainer(command) {
    try {
      const fullCommand = `docker exec ${this.containerName} ${command}`;
      const output = execSync(fullCommand, {
        encoding: 'utf8',
        timeout: this.timeout
      });
      return { success: true, output: output.trim() };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        output: error.stdout || error.stderr || ''
      };
    }
  }

  async isContainerRunning() {
    try {
      const result = await this.execInContainer('echo "container_alive"');
      return result.success && result.output.includes('container_alive');
    } catch (error) {
      return false;
    }
  }

  async getNekoStatus() {
    const result = await this.execInContainer('supervisorctl status neko');

    if (!result.success) {
      return {
        running: false,
        status: 'error',
        error: result.error,
        details: result.output
      };
    }

    const output = result.output;
    const isRunning = output.includes('RUNNING');
    const isStopped = output.includes('STOPPED');

    return {
      running: isRunning,
      status: isRunning ? 'running' : (isStopped ? 'stopped' : 'unknown'),
      details: output,
      pid: this.extractPid(output),
      uptime: this.extractUptime(output)
    };
  }

  async getAllProcessStatus() {
    const result = await this.execInContainer('supervisorctl status');

    if (!result.success) {
      return {
        success: false,
        error: result.error
      };
    }

    const lines = result.output.split('\n').filter(line => line.trim());
    const processes = {};

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0];
        const status = parts[1];
        const isRunning = status === 'RUNNING';

        processes[name] = {
          status,
          running: isRunning,
          details: line.trim()
        };

        if (isRunning && parts.length >= 4) {
          processes[name].pid = this.extractPid(line);
          processes[name].uptime = this.extractUptime(line);
        }
      }
    }

    return {
      success: true,
      processes
    };
  }

  async startNeko() {
    console.log('🚀 Starting neko broadcast service...');

    const result = await this.execInContainer('supervisorctl start neko');

    if (!result.success) {
      console.error('❌ Failed to start neko:', result.error);
      return { success: false, error: result.error };
    }

    // Verify it started
    await new Promise(resolve => setTimeout(resolve, 1000));
    const status = await this.getNekoStatus();

    if (status.running) {
      console.log('✅ Neko started successfully');
      console.log(`   PID: ${status.pid}, Status: ${status.details}`);
    } else {
      console.log('⚠️  Neko start command executed but service not running');
      console.log(`   Status: ${status.details}`);
    }

    return {
      success: status.running,
      status: status,
      output: result.output
    };
  }

  async stopNeko() {
    console.log('🛑 Stopping neko broadcast service...');

    const result = await this.execInContainer('supervisorctl stop neko');

    if (!result.success) {
      console.error('❌ Failed to stop neko:', result.error);
      return { success: false, error: result.error };
    }

    // Verify it stopped
    await new Promise(resolve => setTimeout(resolve, 1000));
    const status = await this.getNekoStatus();

    if (!status.running) {
      console.log('✅ Neko stopped successfully');
    } else {
      console.log('⚠️  Neko stop command executed but service still running');
      console.log(`   Status: ${status.details}`);
    }

    return {
      success: !status.running,
      status: status,
      output: result.output
    };
  }

  async restartNeko() {
    console.log('🔄 Restarting neko broadcast service...');

    const result = await this.execInContainer('supervisorctl restart neko');

    if (!result.success) {
      console.error('❌ Failed to restart neko:', result.error);
      return { success: false, error: result.error };
    }

    // Verify it restarted
    await new Promise(resolve => setTimeout(resolve, 2000));
    const status = await this.getNekoStatus();

    if (status.running) {
      console.log('✅ Neko restarted successfully');
      console.log(`   PID: ${status.pid}, Status: ${status.details}`);
    } else {
      console.log('⚠️  Neko restart command executed but service not running');
      console.log(`   Status: ${status.details}`);
    }

    return {
      success: status.running,
      status: status,
      output: result.output
    };
  }

  async getCpuUsage() {
    const status = await this.getNekoStatus();
    if (!status.running || !status.pid) {
      return { running: false };
    }

    const result = await this.execInContainer(`cat /proc/${status.pid}/stat 2>/dev/null`);
    if (!result.success) {
      return { running: true, error: 'Could not read process stats' };
    }

    const statParts = result.output.split(' ');
    if (statParts.length < 15) {
      return { running: true, error: 'Invalid stat format' };
    }

    const utime = parseInt(statParts[13]) || 0; // User CPU time
    const stime = parseInt(statParts[14]) || 0; // Kernel CPU time
    const rss = parseInt(statParts[23]) || 0;   // Resident memory pages

    return {
      running: true,
      pid: status.pid,
      cpuUser: utime,
      cpuSystem: stime,
      cpuTotal: utime + stime,
      memoryKB: rss * 4, // Convert pages to KB
      uptime: status.uptime
    };
  }

  async getMemoryInfo() {
    const result = await this.execInContainer('cat /proc/meminfo | head -5');
    if (!result.success) {
      return { error: 'Could not read memory info' };
    }

    const lines = result.output.split('\n');
    const memInfo = {};

    for (const line of lines) {
      const match = line.match(/^(\w+):\s+(\d+)\s+kB/);
      if (match) {
        memInfo[match[1]] = parseInt(match[2]);
      }
    }

    return memInfo;
  }

  extractPid(statusLine) {
    const match = statusLine.match(/pid (\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  extractUptime(statusLine) {
    const match = statusLine.match(/uptime ([^,\s]+)/);
    return match ? match[1] : null;
  }

  async printStatus() {
    console.log('📊 Neko Service Status');
    console.log('='.repeat(40));

    // Check container
    const containerRunning = await this.isContainerRunning();
    if (!containerRunning) {
      console.log('❌ Container not running or not accessible');
      return;
    }
    console.log('✅ Container is running');

    // Get neko status
    const nekoStatus = await this.getNekoStatus();
    console.log(`🎭 Neko: ${nekoStatus.running ? '✅ RUNNING' : '❌ STOPPED'}`);
    if (nekoStatus.running) {
      console.log(`   PID: ${nekoStatus.pid}, Uptime: ${nekoStatus.uptime}`);
    }
    if (nekoStatus.error) {
      console.log(`   Error: ${nekoStatus.error}`);
    }

    // Get CPU usage if running
    if (nekoStatus.running) {
      const cpuUsage = await this.getCpuUsage();
      if (cpuUsage.running && !cpuUsage.error) {
        console.log(`   CPU Ticks: ${cpuUsage.cpuTotal} (user: ${cpuUsage.cpuUser}, system: ${cpuUsage.cpuSystem})`);
        console.log(`   Memory: ${(cpuUsage.memoryKB / 1024).toFixed(1)}MB`);
      }
    }

    // Get all processes status
    console.log('\n🔧 All Supervised Processes:');
    const allStatus = await this.getAllProcessStatus();
    if (allStatus.success) {
      for (const [name, info] of Object.entries(allStatus.processes)) {
        const icon = info.running ? '✅' : '❌';
        console.log(`   ${icon} ${name}: ${info.status}`);
      }
    }

    // Memory info
    const memInfo = await this.getMemoryInfo();
    if (!memInfo.error) {
      console.log('\n💾 Container Memory:');
      console.log(`   Total: ${(memInfo.MemTotal / 1024).toFixed(1)}MB`);
      console.log(`   Available: ${(memInfo.MemAvailable / 1024).toFixed(1)}MB`);
      console.log(`   Free: ${(memInfo.MemFree / 1024).toFixed(1)}MB`);
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const nekoControl = new NekoControl();

  try {
    switch (command) {
      case 'start':
        await nekoControl.startNeko();
        break;

      case 'stop':
        await nekoControl.stopNeko();
        break;

      case 'restart':
        await nekoControl.restartNeko();
        break;

      case 'status':
        await nekoControl.printStatus();
        break;

      case 'cpu':
        const cpuUsage = await nekoControl.getCpuUsage();
        console.log('CPU Usage:', JSON.stringify(cpuUsage, null, 2));
        break;

      case 'processes':
        const allStatus = await nekoControl.getAllProcessStatus();
        console.log('All Processes:', JSON.stringify(allStatus, null, 2));
        break;

      default:
        console.log(`
Neko Control - Manage neko broadcast service

Usage: node neko-control.js <command>

Commands:
  start       Start neko service
  stop        Stop neko service
  restart     Restart neko service
  status      Show detailed status (default)
  cpu         Show CPU usage info
  processes   Show all supervised processes

Examples:
  node neko-control.js start
  node neko-control.js status
  node neko-control.js stop
        `);

        if (!command) {
          await nekoControl.printStatus();
        }
        break;
    }
  } catch (error) {
    console.error('❌ Neko control failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = NekoControl;