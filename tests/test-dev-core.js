#!/usr/bin/env node

/**
 * Core Dev Mode Test
 * Tests essential dev mode functionality: health check and three sampling methods
 */

const { spawn } = require('child_process');
const path = require('path');

class CoreDevTest {
  constructor() {
    this.testResults = [];
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

  async runTests() {
    console.log('🚀 Core Dev Mode Test Suite');
    console.log('===========================\n');

    // 1. Health check
    await this.testCommand(
      'Health Check',
      'node',
      ['xordi.js', 'health'],
      ['authentication'],
      20000
    );

    // 2. Browser method sampling (default, works without proprietary modules)
    await this.testCommand(
      'Browser Method Sampling',
      'node',
      ['xordi.js', '3', '--method=browser'],
      ['videos'],
      30000
    );

    // 3. Loggedout mode sampling (public timeline)
    await this.testCommand(
      'Loggedout Mode Sampling',
      'node',
      ['xordi.js', '3', '--loggedout'],
      ['videos'],
      30000
    );

    // Generate summary
    this.generateSummary();
  }

  generateSummary() {
    console.log('\n📊 Test Results Summary');
    console.log('========================');

    const passed = this.testResults.filter(t => t.success).length;
    const total = this.testResults.length;

    console.log(`✅ Passed: ${passed}/${total} tests`);

    const failed = this.testResults.filter(t => !t.success);
    if (failed.length > 0) {
      console.log('\n❌ Failed Tests:');
      failed.forEach(test => {
        console.log(`   • ${test.name}: ${test.error || test.issues?.join(', ') || 'Unknown error'}`);
      });
    }

    console.log(`\n🎯 Overall Result: ${passed === total ? '✅ SUCCESS' : '❌ SOME ISSUES'}`);

    if (passed === total) {
      console.log('\n🎉 All core dev mode functionality working correctly!');
    } else {
      console.log('\n🔧 Some core functionality needs attention. Check logs above.');
    }
  }
}

// Run the core test suite
const tester = new CoreDevTest();
tester.runTests().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});