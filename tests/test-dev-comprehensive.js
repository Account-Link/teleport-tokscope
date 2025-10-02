#!/usr/bin/env node

/**
 * Comprehensive Dev Mode Test
 * Tests major dev mode functionality from README and CLI help
 */

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

class DevModeTest {
  constructor() {
    this.testResults = [];
    this.outputDir = path.join(__dirname, '../output');
  }

  async runCommand(command, args = [], timeout = 30000) {
    return new Promise((resolve, reject) => {
      console.log(`🔧 Running: ${command} ${args.join(' ')}`);

      const proc = spawn(command, args, {
        stdio: 'pipe',
        cwd: path.join(__dirname, '..')
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async testCommand(name, command, args, expectedPatterns = [], timeout = 30000) {
    try {
      console.log(`\n📋 Test: ${name}`);
      const result = await this.runCommand(command, args, timeout);

      let success = result.code === 0;
      let issues = [];

      // Check for expected patterns in output
      const output = result.stdout + result.stderr;
      for (const pattern of expectedPatterns) {
        if (!output.includes(pattern)) {
          success = false;
          issues.push(`Missing expected output: "${pattern}"`);
        }
      }

      if (success) {
        console.log(`✅ ${name}: PASSED`);
      } else {
        console.log(`❌ ${name}: FAILED`);
        console.log(`   Exit code: ${result.code}`);
        if (issues.length > 0) {
          console.log(`   Issues: ${issues.join(', ')}`);
        }
        if (result.stderr) {
          console.log(`   Error output: ${result.stderr.slice(0, 200)}...`);
        }
      }

      this.testResults.push({
        name,
        success,
        code: result.code,
        issues,
        output: output.slice(0, 500) // Keep first 500 chars for debugging
      });

      return success;
    } catch (error) {
      console.log(`❌ ${name}: ERROR - ${error.message}`);
      this.testResults.push({
        name,
        success: false,
        error: error.message
      });
      return false;
    }
  }

  async checkOutputFiles() {
    try {
      const files = await fs.readdir(this.outputDir, { recursive: true });
      let recentCount = 0;
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      for (const file of files) {
        try {
          const fullPath = path.join(this.outputDir, file);
          const stats = await fs.stat(fullPath);
          if (stats.isFile() && stats.mtime > fiveMinutesAgo) {
            recentCount++;
          }
        } catch (err) {
          // Skip files that can't be stat'd
        }
      }

      console.log(`📁 Recent output files: ${recentCount}`);
      return recentCount > 0;
    } catch (error) {
      console.log(`📁 Could not check output files: ${error.message}`);
      return false;
    }
  }

  async runTests() {
    console.log('🚀 Comprehensive Dev Mode Test Suite');
    console.log('=====================================\n');

    // 1. Health check
    await this.testCommand(
      'Health Check',
      'node',
      ['xordi.js', 'health'],
      ['authentication'],
      15000
    );

    // 2. Status check
    await this.testCommand(
      'Container Status',
      'node',
      ['xordi.js', 'status'],
      ['development environment'],
      10000
    );

    // 3. Start container
    await this.testCommand(
      'Container Start',
      'node',
      ['xordi.js', 'start'],
      ['environment'],
      20000
    );

    // 4. Screenshot
    await this.testCommand(
      'Screenshot Capture',
      'node',
      ['xordi.js', 'screenshot'],
      ['Screenshot saved'],
      15000
    );

    // 5. Inspect current page
    await this.testCommand(
      'Page Inspection',
      'node',
      ['xordi.js', 'inspect'],
      ['Page Analysis'],
      15000
    );

    // 6. Navigate to For You page
    await this.testCommand(
      'Navigate to For You',
      'node',
      ['xordi.js', 'navigate', 'foryou'],
      ['Successfully navigated'],
      20000
    );

    // 7. Test loggedout mode (works without auth)
    await this.testCommand(
      'Loggedout Mode Sampling',
      'node',
      ['xordi.js', '2', '--loggedout'],
      ['videos'],
      25000
    );

    // 9. Test browser method (2 videos)
    await this.testCommand(
      'Browser Method Sampling',
      'node',
      ['xordi.js', '2', '--method=browser'],
      ['videos'],
      30000
    );

    // 10. Watch history
    await this.testCommand(
      'Watch History Access',
      'node',
      ['xordi.js', 'watch-history', '5'],
      ['watch history'],
      20000
    );

    // 11. Test selector functionality
    await this.testCommand(
      'Selector Testing',
      'node',
      ['xordi.js', 'test', 'video'],
      ['Testing selectors'],
      15000
    );

    // 12. Extract data test
    await this.testCommand(
      'Data Extraction Test',
      'node',
      ['xordi.js', 'extract'],
      ['extract', 'data'],
      15000
    );

    // 13. Stop container
    await this.testCommand(
      'Container Stop',
      'node',
      ['xordi.js', 'stop'],
      ['stopped', 'environment'],
      15000
    );

    // Check if output files were created
    const hasOutputFiles = await this.checkOutputFiles();

    // Generate summary
    this.generateSummary(hasOutputFiles);
  }

  generateSummary(hasOutputFiles) {
    console.log('\n📊 Test Results Summary');
    console.log('========================');

    const passed = this.testResults.filter(t => t.success).length;
    const total = this.testResults.length;

    console.log(`✅ Passed: ${passed}/${total} tests`);
    console.log(`📁 Output Files: ${hasOutputFiles ? '✅ Created' : '❌ Missing'}`);

    const failed = this.testResults.filter(t => !t.success);
    if (failed.length > 0) {
      console.log('\n❌ Failed Tests:');
      failed.forEach(test => {
        console.log(`   • ${test.name}: ${test.error || test.issues?.join(', ') || 'Unknown error'}`);
      });
    }

    console.log(`\n🎯 Overall Result: ${passed === total && hasOutputFiles ? '✅ SUCCESS' : '❌ SOME ISSUES'}`);

    if (passed === total && hasOutputFiles) {
      console.log('\n🎉 All dev mode features working correctly!');
    } else {
      console.log('\n🔧 Some dev mode features need attention. Check logs above.');
    }
  }
}

// Run the comprehensive test suite
const tester = new DevModeTest();
tester.runTests().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});