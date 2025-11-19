/**
 * QRMetricsCollector - Aggregate metrics and provide analytics
 *
 * Stores last 100 QR sessions in memory
 * Provides analytics endpoint for live monitoring
 * Generates auto-recommendations for tuning
 */

interface QRSession {
  sessionId: string | null;
  success: boolean;
  strategyUsed: string | null;
  retryNumber: number;
  attemptNumber: number;
  phases: {
    pageLoad: number;
    qrExtraction: number;
    userScan: number;
    cookieDetection: number;
  };
  totalDuration: number;
  bottleneck: string;
  timestampMs: number;
  error?: string;
}

interface StrategyStats {
  strategy: string;
  usageCount: number;
  usagePercent: string;
  avgDuration: string;
  avgAttemptNumber: string;
}

interface BottleneckStats {
  phase: string;
  count: number;
  percentage: string;
}

interface Recommendation {
  severity: 'info' | 'warning' | 'success';
  message: string;
  action: string;
  file?: string;
  line?: string;
  note?: string;
}

interface Analytics {
  summary: {
    totalSessions: number;
    successful: number;
    failed: number;
    successRate: string;
  };
  timeRange: {
    oldest: Date;
    newest: Date;
  };
  averages: {
    pageLoad: string;
    qrExtraction: string;
    userScan: string;
    cookieDetection: string;
    total: string;
  } | null;
  strategyBreakdown: StrategyStats[];
  bottlenecks: BottleneckStats[];
  recommendations: Recommendation[];
}

export class QRMetricsCollector {
  private static recentSessions: QRSession[] = [];
  private static maxSessions = 100;

  /**
   * Log a completed QR session
   */
  static logSession(metrics: QRSession): void {
    // Add timestamp if not present
    if (!metrics.timestampMs) {
      metrics.timestampMs = Date.now();
    }

    // Store in memory
    this.recentSessions.push(metrics);

    // Trim to max size
    if (this.recentSessions.length > this.maxSessions) {
      this.recentSessions.shift();
    }

    // Log for grep/monitoring
    console.log('[QR_METRICS_COLLECTED]', JSON.stringify({
      sessionId: metrics.sessionId,
      success: metrics.success,
      totalDuration: metrics.totalDuration,
      strategyUsed: metrics.strategyUsed,
      bottleneck: metrics.bottleneck
    }));
  }

  /**
   * Get analytics summary
   */
  static getAnalytics(): Analytics {
    if (this.recentSessions.length === 0) {
      return {
        summary: {
          totalSessions: 0,
          successful: 0,
          failed: 0,
          successRate: '0%'
        },
        timeRange: {
          oldest: new Date(),
          newest: new Date()
        },
        averages: null,
        strategyBreakdown: [],
        bottlenecks: [],
        recommendations: [{
          severity: 'info',
          message: 'No QR sessions recorded yet',
          action: 'Run more QR logins to gather data'
        }]
      };
    }

    const successful = this.recentSessions.filter(s => s.success);
    const failed = this.recentSessions.filter(s => !s.success);

    return {
      summary: {
        totalSessions: this.recentSessions.length,
        successful: successful.length,
        failed: failed.length,
        successRate: (successful.length / this.recentSessions.length * 100).toFixed(1) + '%'
      },
      timeRange: {
        oldest: new Date(this.recentSessions[0].timestampMs),
        newest: new Date(this.recentSessions[this.recentSessions.length - 1].timestampMs)
      },
      averages: this.calculateAverages(successful),
      strategyBreakdown: this.strategyStats(successful),
      bottlenecks: this.bottleneckAnalysis(successful),
      recommendations: this.generateRecommendations(successful)
    };
  }

  /**
   * Calculate average durations
   */
  private static calculateAverages(sessions: QRSession[]) {
    if (sessions.length === 0) return null;

    return {
      pageLoad: this.avg(sessions, 'phases.pageLoad') + 'ms',
      qrExtraction: this.avg(sessions, 'phases.qrExtraction') + 'ms',
      userScan: this.avg(sessions, 'phases.userScan') + 'ms',
      cookieDetection: this.avg(sessions, 'phases.cookieDetection') + 'ms',
      total: this.avg(sessions, 'totalDuration') + 'ms'
    };
  }

  /**
   * Breakdown by retry strategy used
   */
  private static strategyStats(sessions: QRSession[]): StrategyStats[] {
    const stats: Record<string, { count: number; durations: number[]; attemptNumbers: number[] }> = {};

    sessions.forEach(s => {
      const strategy = s.strategyUsed || 'unknown';
      if (!stats[strategy]) {
        stats[strategy] = {
          count: 0,
          durations: [],
          attemptNumbers: []
        };
      }
      stats[strategy].count++;
      if (s.phases?.qrExtraction) {
        stats[strategy].durations.push(s.phases.qrExtraction);
      }
      if (s.attemptNumber) {
        stats[strategy].attemptNumbers.push(s.attemptNumber);
      }
    });

    return Object.entries(stats)
      .map(([strategy, data]) => ({
        strategy,
        usageCount: data.count,
        usagePercent: (data.count / sessions.length * 100).toFixed(1) + '%',
        avgDuration: data.durations.length > 0
          ? (data.durations.reduce((a, b) => a + b, 0) / data.count).toFixed(0) + 'ms'
          : 'N/A',
        avgAttemptNumber: data.attemptNumbers.length > 0
          ? (data.attemptNumbers.reduce((a, b) => a + b, 0) / data.attemptNumbers.length).toFixed(1)
          : 'N/A'
      }))
      .sort((a, b) => b.usageCount - a.usageCount);
  }

  /**
   * Analyze which phases are bottlenecks
   */
  private static bottleneckAnalysis(sessions: QRSession[]): BottleneckStats[] {
    const bottlenecks: Record<string, number> = {};

    sessions.forEach(s => {
      const bottleneck = s.bottleneck || 'unknown';
      bottlenecks[bottleneck] = (bottlenecks[bottleneck] || 0) + 1;
    });

    return Object.entries(bottlenecks)
      .map(([phase, count]) => ({
        phase,
        count,
        percentage: (count / sessions.length * 100).toFixed(1) + '%'
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Generate auto-recommendations based on metrics
   */
  private static generateRecommendations(sessions: QRSession[]): Recommendation[] {
    if (sessions.length < 5) {
      return [{
        severity: 'info',
        message: `Only ${sessions.length} sessions recorded. Need at least 5 for meaningful recommendations.`,
        action: 'Run more QR logins to gather data'
      }];
    }

    const recs: Recommendation[] = [];
    const stats = this.strategyStats(sessions);

    // Recommendation 1: fast-v1 success rate
    const fastV1 = stats.find(s => s.strategy === 'fast-parallel-v1');
    if (fastV1) {
      const usagePercent = parseFloat(fastV1.usagePercent);
      if (usagePercent < 50) {
        recs.push({
          severity: 'warning',
          message: `fast-v1 only succeeds ${fastV1.usagePercent} of the time (target: >60%). Page load may be slower than expected.`,
          action: 'Consider increasing RETRY_STRATEGY[0].initialWait from 500ms to 700ms',
          file: '/lib/qr-extractor.ts',
          line: 'RETRY_STRATEGY[0].initialWait'
        });
      } else if (usagePercent >= 60) {
        recs.push({
          severity: 'success',
          message: `fast-v1 succeeds ${fastV1.usagePercent} of the time - performing well!`,
          action: 'No changes needed'
        });
      }
    }

    // Recommendation 2: Safety net overuse
    const safeFallback = stats.find(s => s.strategy === 'safe-sequential');
    if (safeFallback) {
      const usagePercent = parseFloat(safeFallback.usagePercent);
      if (usagePercent > 15) {
        recs.push({
          severity: 'warning',
          message: `Safety net (safe-sequential) used ${safeFallback.usagePercent} of the time (target: <10%). Fast strategies may be too aggressive.`,
          action: 'Increase timeouts across all fast strategies by 20-30%',
          file: '/lib/qr-extractor.ts'
        });
      }
    }

    // Recommendation 3: QR Extraction bottleneck
    const avgQrExtraction = parseInt(this.avg(sessions, 'phases.qrExtraction'));
    if (avgQrExtraction > 5000) {
      recs.push({
        severity: 'info',
        message: `Average QR extraction time is ${avgQrExtraction}ms (5+ seconds). This is the primary bottleneck.`,
        action: 'Phase 2 (network events) should help reduce this significantly',
        note: 'Expected improvement: 50-70% reduction with network event detection'
      });
    }

    // Recommendation 4: Page load bottleneck
    const bottlenecks = this.bottleneckAnalysis(sessions);
    const pageLoadBottleneck = bottlenecks.find(b => b.phase === 'pageLoad');
    if (pageLoadBottleneck && parseFloat(pageLoadBottleneck.percentage) > 30) {
      recs.push({
        severity: 'info',
        message: `Page load is the bottleneck ${pageLoadBottleneck.percentage} of the time.`,
        action: 'Consider adding browser optimization flags',
        note: 'Expected improvement: 1-3 seconds from browser flags'
      });
    }

    return recs;
  }

  /**
   * Helper: Calculate average of nested property
   */
  private static avg(arr: QRSession[], path: string): number {
    const values = arr.map(item => {
      return path.split('.').reduce((obj: any, key) => obj?.[key], item);
    }).filter(v => v !== null && v !== undefined && !isNaN(v));

    return values.length > 0
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : 0;
  }

  /**
   * Get raw sessions (for debugging)
   */
  static getRawSessions(limit: number = 10): QRSession[] {
    return this.recentSessions.slice(-limit).reverse();
  }

  /**
   * Clear all sessions (for testing)
   */
  static clear(): void {
    this.recentSessions = [];
    console.log('[QR_METRICS] Cleared all sessions');
  }
}
