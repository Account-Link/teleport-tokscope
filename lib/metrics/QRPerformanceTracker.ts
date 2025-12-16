/**
 * QRPerformanceTracker - Tracks performance metrics for QR extraction
 *
 * Tracks timing marks for each phase and provides detailed performance report
 */

interface TimingMark {
  timestamp: number;
}

interface PerformanceReport {
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

export class QRPerformanceTracker {
  private sessionId: string | null;
  private marks: Map<string, TimingMark>;
  private strategyUsed: string | null = null;
  private retryNumber: number = 0;
  private attemptNumber: number = 0;
  private success: boolean = false;
  private error: string | null = null;

  constructor(sessionId: string | null = null) {
    this.sessionId = sessionId;
    this.marks = new Map();
  }

  /**
   * Mark a timing point
   */
  mark(label: string): void {
    this.marks.set(label, { timestamp: Date.now() });
  }

  /**
   * Set the strategy used
   */
  setStrategy(strategyName: string, retryNumber: number, attemptNumber: number): void {
    this.strategyUsed = strategyName;
    this.retryNumber = retryNumber;
    this.attemptNumber = attemptNumber;
  }

  /**
   * Mark as successful
   */
  markSuccess(): void {
    this.success = true;
  }

  /**
   * Mark as failed
   */
  markFailure(error: Error): void {
    this.success = false;
    this.error = error.message;
  }

  /**
   * Calculate duration between two marks
   */
  private getDuration(startLabel: string, endLabel: string): number {
    const start = this.marks.get(startLabel);
    const end = this.marks.get(endLabel);

    if (!start || !end) return 0;
    return end.timestamp - start.timestamp;
  }

  /**
   * Generate performance report
   */
  getReport(): PerformanceReport {
    const phases = {
      pageLoad: this.getDuration('total_start', 'qrExtraction_start'),
      qrExtraction: this.getDuration('qrExtraction_start', 'qrExtraction_end'),
      userScan: this.getDuration('qrExtraction_end', 'cookieDetection_start'),
      cookieDetection: this.getDuration('cookieDetection_start', 'total_end')
    };

    const totalDuration = this.getDuration('total_start', 'total_end');

    // Determine bottleneck (longest phase)
    let bottleneck = 'unknown';
    let maxDuration = 0;
    for (const [phase, duration] of Object.entries(phases)) {
      if (duration > maxDuration) {
        maxDuration = duration;
        bottleneck = phase;
      }
    }

    const report: PerformanceReport = {
      sessionId: this.sessionId,
      success: this.success,
      strategyUsed: this.strategyUsed,
      retryNumber: this.retryNumber,
      attemptNumber: this.attemptNumber,
      phases,
      totalDuration,
      bottleneck,
      timestampMs: Date.now()
    };

    if (this.error) {
      report.error = this.error;
    }

    return report;
  }

  /**
   * Log performance report to console
   */
  logReport(): PerformanceReport {
    const report = this.getReport();

    // One-liner summary
    console.log(`[QR] ${report.success ? '✅' : '❌'} ${report.totalDuration}ms (${report.bottleneck})${report.error ? ' ERR: ' + report.error : ''}`);

    // Verbose report - uncomment for debugging
    // console.log('\n=== QR Performance Report ===');
    // console.log(`Session: ${report.sessionId || 'unknown'}`);
    // console.log(`Success: ${report.success}`);
    // console.log(`Strategy: ${report.strategyUsed} (retry ${report.retryNumber}, attempt ${report.attemptNumber})`);
    // console.log(`Total Duration: ${report.totalDuration}ms`);
    // console.log(`Phases:`);
    // console.log(`  - Page Load: ${report.phases.pageLoad}ms`);
    // console.log(`  - QR Extraction: ${report.phases.qrExtraction}ms`);
    // console.log(`  - User Scan: ${report.phases.userScan}ms`);
    // console.log(`  - Cookie Detection: ${report.phases.cookieDetection}ms`);
    // console.log(`Bottleneck: ${report.bottleneck} (${(report.phases as any)[report.bottleneck]}ms)`);
    // if (report.error) {
    //   console.log(`Error: ${report.error}`);
    // }
    // console.log('============================\n');

    return report;
  }
}
