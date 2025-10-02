#!/usr/bin/env node

/**
 * CPU Monitor - Monitor process CPU usage over time
 *
 * Tracks CPU and memory usage of container processes with high precision sampling
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

class CPUMonitor {
  constructor(options = {}) {
    this.duration = options.duration || 10; // seconds
    this.interval = options.interval || 500; // milliseconds
    this.outputDir = options.outputDir || path.join(__dirname, '..', 'output', 'cpu-monitoring');
    this.containerName = options.containerName || 'simple-auth-container';
    this.processes = options.processes || ['neko', 'chromium', 'openbox', 'x-server'];
    this.measurements = [];
    this.startTime = null;
  }

  async init() {
    try {
      await fs.mkdir(this.outputDir, { recursive: true });
      console.log(`📊 CPU Monitor initialized - ${this.duration}s duration, ${this.interval}ms interval`);
    } catch (error) {
      console.error('Failed to initialize CPU monitor:', error.message);
      throw error;
    }
  }

  async getProcessStats(containerName) {
    try {
      // Get all processes with their stats in one command
      const command = `docker exec ${containerName} sh -c "
        echo '--- PROCESS_STATS ---';
        for pid in \\$(ls /proc/*/comm 2>/dev/null | cut -d'/' -f3); do
          comm=\\$(cat /proc/\\$pid/comm 2>/dev/null);
          if [ -f /proc/\\$pid/stat ]; then
            stat=\\$(cat /proc/\\$pid/stat 2>/dev/null);
            echo \\$pid \\$comm \\$stat;
          fi;
        done
      "`;

      const output = execSync(command, { encoding: 'utf8', timeout: 5000 });
      const lines = output.split('\n').filter(line => line.trim() && !line.includes('PROCESS_STATS'));

      const processStats = {};

      for (const line of lines) {
        const parts = line.trim().split(' ');
        if (parts.length < 15) continue;

        const [pid, comm, ...statParts] = parts;

        // Parse stat fields (see man proc for field definitions)
        const utime = parseInt(statParts[11]) || 0; // User CPU time
        const stime = parseInt(statParts[12]) || 0; // Kernel CPU time
        const rss = parseInt(statParts[21]) || 0;   // Resident memory pages
        const threads = parseInt(statParts[17]) || 1; // Number of threads

        if (!processStats[comm]) {
          processStats[comm] = {
            processes: [],
            totalCpuUser: 0,
            totalCpuSystem: 0,
            totalMemoryKB: 0,
            totalThreads: 0
          };
        }

        processStats[comm].processes.push({
          pid: parseInt(pid),
          cpuUser: utime,
          cpuSystem: stime,
          memoryKB: rss * 4, // Convert pages to KB (assuming 4KB pages)
          threads: threads
        });

        processStats[comm].totalCpuUser += utime;
        processStats[comm].totalCpuSystem += stime;
        processStats[comm].totalMemoryKB += rss * 4;
        processStats[comm].totalThreads += threads;
      }

      return processStats;
    } catch (error) {
      console.warn(`Warning: Could not get process stats: ${error.message}`);
      return {};
    }
  }

  async getContainerStats(containerName) {
    try {
      const command = `docker stats ${containerName} --no-stream --format "table {{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}}"`;
      const output = execSync(command, { encoding: 'utf8', timeout: 3000 });
      const lines = output.trim().split('\n');

      if (lines.length < 2) return null;

      const [cpuPerc, memUsage, netIO, blockIO] = lines[1].split(',');

      return {
        cpuPercent: parseFloat(cpuPerc.replace('%', '')) || 0,
        memoryUsage: memUsage.trim(),
        networkIO: netIO.trim(),
        blockIO: blockIO.trim()
      };
    } catch (error) {
      console.warn(`Warning: Could not get container stats: ${error.message}`);
      return null;
    }
  }

  async getHostProcessStats() {
    try {
      // Get host-level view of container processes
      const command = `ps aux | grep -E "(neko|chromium)" | grep -v grep`;
      const output = execSync(command, { encoding: 'utf8', timeout: 5000 });
      const lines = output.split('\n').filter(line => line.trim());

      const hostStats = {};

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;

        const [user, pid, cpuPercent, memPercent, vsz, rss, tty, stat, start, time, ...cmd] = parts;
        const command = cmd.join(' ');

        // Determine process type
        let processType = 'unknown';
        if (command.includes('/usr/bin/neko serve')) {
          processType = 'neko';
        } else if (command.includes('chromium') || command.includes('chrome')) {
          processType = 'chromium';
        } else if (command.includes('supervisord')) {
          processType = 'supervisor';
        } else if (command.includes('openbox')) {
          processType = 'openbox';
        } else if (command.includes('Xorg')) {
          processType = 'x-server';
        }

        if (!hostStats[processType]) {
          hostStats[processType] = {
            processes: [],
            totalCpuPercent: 0,
            totalMemoryKB: 0,
            totalMemoryPercent: 0
          };
        }

        const cpuPerc = parseFloat(cpuPercent) || 0;
        const memPerc = parseFloat(memPercent) || 0;
        const memKB = parseInt(rss) || 0; // RSS is in KB

        hostStats[processType].processes.push({
          pid: parseInt(pid),
          cpuPercent: cpuPerc,
          memoryPercent: memPerc,
          memoryKB: memKB,
          command: command.substring(0, 100) // Truncate long commands
        });

        hostStats[processType].totalCpuPercent += cpuPerc;
        hostStats[processType].totalMemoryKB += memKB;
        hostStats[processType].totalMemoryPercent += memPerc;
      }

      return hostStats;
    } catch (error) {
      console.warn(`Warning: Could not get host process stats: ${error.message}`);
      return {};
    }
  }

  async takeMeasurement() {
    const timestamp = Date.now();
    const relativeTime = this.startTime ? timestamp - this.startTime : 0;

    console.log(`📊 Measuring... (${(relativeTime / 1000).toFixed(1)}s)`);

    const [processStats, containerStats, hostStats] = await Promise.all([
      this.getProcessStats(this.containerName),
      this.getContainerStats(this.containerName),
      this.getHostProcessStats()
    ]);

    const measurement = {
      timestamp,
      relativeTime,
      processStats,
      containerStats,
      hostStats
    };

    this.measurements.push(measurement);
    return measurement;
  }

  async monitor() {
    await this.init();

    this.startTime = Date.now();
    const endTime = this.startTime + (this.duration * 1000);

    console.log(`🎯 Starting CPU monitoring for ${this.duration} seconds...`);
    console.log(`📈 Tracking processes: ${this.processes.join(', ')}`);

    // Take initial measurement
    await this.takeMeasurement();

    return new Promise((resolve, reject) => {
      const intervalId = setInterval(async () => {
        try {
          const now = Date.now();

          if (now >= endTime) {
            clearInterval(intervalId);
            console.log('✅ Monitoring completed');
            resolve(this.measurements);
            return;
          }

          await this.takeMeasurement();
        } catch (error) {
          clearInterval(intervalId);
          reject(error);
        }
      }, this.interval);
    });
  }

  calculateDeltas(measurements) {
    if (measurements.length < 2) return [];

    const deltas = [];

    for (let i = 1; i < measurements.length; i++) {
      const prev = measurements[i - 1];
      const curr = measurements[i];
      const timeDelta = (curr.timestamp - prev.timestamp) / 1000; // seconds

      const processDelta = {};

      // Calculate CPU usage deltas for each process type
      for (const [processName, currStats] of Object.entries(curr.processStats)) {
        const prevStats = prev.processStats[processName];
        if (!prevStats) continue;

        const cpuUserDelta = currStats.totalCpuUser - prevStats.totalCpuUser;
        const cpuSystemDelta = currStats.totalCpuSystem - prevStats.totalCpuSystem;

        // Convert CPU ticks to percentage (assuming 100 Hz clock)
        const cpuUserPercent = (cpuUserDelta / 100 / timeDelta) * 100;
        const cpuSystemPercent = (cpuSystemDelta / 100 / timeDelta) * 100;

        processDelta[processName] = {
          cpuUserPercent: Math.max(0, cpuUserPercent),
          cpuSystemPercent: Math.max(0, cpuSystemPercent),
          cpuTotalPercent: Math.max(0, cpuUserPercent + cpuSystemPercent),
          memoryKB: currStats.totalMemoryKB,
          processCount: currStats.processes.length,
          threadCount: currStats.totalThreads
        };
      }

      deltas.push({
        timestamp: curr.timestamp,
        relativeTime: curr.relativeTime,
        timeDelta,
        processDelta,
        containerStats: curr.containerStats
      });
    }

    return deltas;
  }

  generateSummary(measurements, deltas) {
    if (deltas.length === 0) {
      return { error: 'Insufficient data for analysis' };
    }

    const summary = {
      duration: this.duration,
      measurements: measurements.length,
      processes: {},
      hostProcesses: {}
    };

    // Calculate averages for each process (container-internal)
    for (const processName of this.processes) {
      const processDeltas = deltas
        .map(d => d.processDelta[processName])
        .filter(Boolean);

      if (processDeltas.length === 0) {
        summary.processes[processName] = { status: 'not_found' };
        continue;
      }

      const avgCpuUser = processDeltas.reduce((sum, d) => sum + d.cpuUserPercent, 0) / processDeltas.length;
      const avgCpuSystem = processDeltas.reduce((sum, d) => sum + d.cpuSystemPercent, 0) / processDeltas.length;
      const avgCpuTotal = processDeltas.reduce((sum, d) => sum + d.cpuTotalPercent, 0) / processDeltas.length;
      const avgMemory = processDeltas.reduce((sum, d) => sum + d.memoryKB, 0) / processDeltas.length;
      const maxCpuTotal = Math.max(...processDeltas.map(d => d.cpuTotalPercent));
      const maxMemory = Math.max(...processDeltas.map(d => d.memoryKB));

      summary.processes[processName] = {
        status: 'active',
        avgCpuUser: parseFloat(avgCpuUser.toFixed(2)),
        avgCpuSystem: parseFloat(avgCpuSystem.toFixed(2)),
        avgCpuTotal: parseFloat(avgCpuTotal.toFixed(2)),
        maxCpuTotal: parseFloat(maxCpuTotal.toFixed(2)),
        avgMemoryKB: Math.round(avgMemory),
        maxMemoryKB: Math.round(maxMemory),
        avgProcessCount: Math.round(processDeltas.reduce((sum, d) => sum + d.processCount, 0) / processDeltas.length),
        avgThreadCount: Math.round(processDeltas.reduce((sum, d) => sum + d.threadCount, 0) / processDeltas.length)
      };
    }

    // Calculate averages for host processes
    const hostProcessTypes = ['neko', 'chromium', 'x-server', 'supervisor', 'openbox'];

    for (const processType of hostProcessTypes) {
      const hostMeasurements = measurements
        .map(m => m.hostStats[processType])
        .filter(Boolean);

      if (hostMeasurements.length === 0) {
        summary.hostProcesses[processType] = { status: 'not_found' };
        continue;
      }

      const avgCpuPercent = hostMeasurements.reduce((sum, h) => sum + h.totalCpuPercent, 0) / hostMeasurements.length;
      const avgMemory = hostMeasurements.reduce((sum, h) => sum + h.totalMemoryKB, 0) / hostMeasurements.length;
      const maxCpuPercent = Math.max(...hostMeasurements.map(h => h.totalCpuPercent));
      const maxMemory = Math.max(...hostMeasurements.map(h => h.totalMemoryKB));

      summary.hostProcesses[processType] = {
        status: 'active',
        avgCpuPercent: parseFloat(avgCpuPercent.toFixed(2)),
        maxCpuPercent: parseFloat(maxCpuPercent.toFixed(2)),
        avgMemoryKB: Math.round(avgMemory),
        maxMemoryKB: Math.round(maxMemory),
        avgProcessCount: Math.round(hostMeasurements.reduce((sum, h) => sum + h.processes.length, 0) / hostMeasurements.length)
      };
    }

    return summary;
  }

  async saveResults(measurements, scenario = 'default') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `cpu-monitor-${scenario}-${timestamp}`;

    const deltas = this.calculateDeltas(measurements);
    const summary = this.generateSummary(measurements, deltas);

    const results = {
      scenario,
      timestamp: new Date().toISOString(),
      config: {
        duration: this.duration,
        interval: this.interval,
        processes: this.processes,
        containerName: this.containerName
      },
      summary,
      measurements,
      deltas
    };

    // Save detailed JSON
    const jsonPath = path.join(this.outputDir, `${filename}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(results, null, 2));

    // Save CSV summary
    const csvPath = path.join(this.outputDir, `${filename}-summary.csv`);
    await this.saveSummaryCSV(summary, csvPath);

    console.log(`💾 Results saved:`);
    console.log(`   📄 Detailed: ${jsonPath}`);
    console.log(`   📊 Summary: ${csvPath}`);

    return results;
  }

  async saveSummaryCSV(summary, csvPath) {
    const lines = ['Process,Status,AvgCpuUser%,AvgCpuSystem%,AvgCpuTotal%,MaxCpuTotal%,AvgMemoryKB,MaxMemoryKB,AvgProcesses,AvgThreads'];

    for (const [processName, stats] of Object.entries(summary.processes)) {
      if (stats.status === 'not_found') {
        lines.push(`${processName},not_found,0,0,0,0,0,0,0,0`);
      } else {
        lines.push(`${processName},active,${stats.avgCpuUser},${stats.avgCpuSystem},${stats.avgCpuTotal},${stats.maxCpuTotal},${stats.avgMemoryKB},${stats.maxMemoryKB},${stats.avgProcessCount},${stats.avgThreadCount}`);
      }
    }

    await fs.writeFile(csvPath, lines.join('\n'));
  }

  printSummary(summary) {
    console.log('\n📊 CPU Monitoring Summary');
    console.log('='.repeat(50));

    // Container-internal stats
    console.log('🔵 Container-Internal View:');
    for (const [processName, stats] of Object.entries(summary.processes)) {
      if (stats.status === 'not_found') {
        console.log(`   ❌ ${processName}: Not found`);
        continue;
      }

      console.log(`   🔄 ${processName}:`);
      console.log(`      CPU: ${stats.avgCpuTotal}% avg (${stats.maxCpuTotal}% peak)`);
      console.log(`      Memory: ${(stats.avgMemoryKB / 1024).toFixed(1)}MB avg (${(stats.maxMemoryKB / 1024).toFixed(1)}MB peak)`);
      console.log(`      Processes: ${stats.avgProcessCount} avg, Threads: ${stats.avgThreadCount} avg`);
    }

    // Host-level stats
    if (summary.hostProcesses) {
      console.log('\n🔴 Host-Level View (Real CPU Usage):');
      for (const [processName, stats] of Object.entries(summary.hostProcesses)) {
        if (stats.status === 'not_found') {
          console.log(`   ❌ ${processName}: Not found`);
          continue;
        }

        console.log(`   🔄 ${processName}:`);
        console.log(`      CPU: ${stats.avgCpuPercent}% avg (${stats.maxCpuPercent}% peak)`);
        console.log(`      Memory: ${(stats.avgMemoryKB / 1024).toFixed(1)}MB avg (${(stats.maxMemoryKB / 1024).toFixed(1)}MB peak)`);
        console.log(`      Processes: ${stats.avgProcessCount} avg`);
      }
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  const options = {
    duration: 10,
    interval: 500,
    scenario: 'default'
  };

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--duration' && args[i + 1]) {
      options.duration = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--interval' && args[i + 1]) {
      options.interval = parseInt(args[i + 1]);
      i++;
    } else if (arg === '--scenario' && args[i + 1]) {
      options.scenario = args[i + 1];
      i++;
    } else if (arg === '--help') {
      console.log(`
CPU Monitor - Monitor container process CPU usage

Usage: node cpu-monitor.js [options]

Options:
  --duration <seconds>   Monitoring duration (default: 10)
  --interval <ms>        Sampling interval (default: 500)
  --scenario <name>      Scenario name for output files (default: "default")
  --help                 Show this help

Examples:
  node cpu-monitor.js --duration 30 --scenario tiktok-active
  node cpu-monitor.js --interval 250 --duration 5
      `);
      return;
    }
  }

  try {
    const monitor = new CPUMonitor(options);
    const measurements = await monitor.monitor();
    const results = await monitor.saveResults(measurements, options.scenario);

    monitor.printSummary(results.summary);

  } catch (error) {
    console.error('❌ CPU monitoring failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = CPUMonitor;