import assert from 'assert';
import { prisma } from '../src/lib/prisma';
import {
  calculateGateCycleAnalytics,
  generateDateRangeList,
  getISTDateString,
  formatDurationHuman,
  getFullCycleAnalytics,
  GateMetadata
} from '../src/lib/cycleReportService';
import {
  exportCompleteLogExcel,
  exportCompleteLogPdf,
  exportCycleExcel,
  exportCyclePdf,
  exportCompleteLogCsv,
  exportCycleCsv,
  CompleteLogReportData
} from '../src/lib/reportExporter';
import fs from 'fs';
import path from 'path';

// Helper to create mock response that captures binary buffer asynchronously
function createMockResponse(): { res: any; done: Promise<{ buffer: Buffer; statusCode: number }> } {
  const headers: Record<string, string> = {};
  let resolveDone: (val: { buffer: Buffer; statusCode: number }) => void;
  const done = new Promise<{ buffer: Buffer; statusCode: number }>(resolve => {
    resolveDone = resolve;
  });
  let statusCode = 200;

  const res = {
    headersSent: false,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return {
        send(buf: Buffer | string) {
          const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
          resolveDone({ buffer, statusCode });
        },
        json(data: any) {
          resolveDone({ buffer: Buffer.from(JSON.stringify(data)), statusCode });
        }
      };
    }
  };

  return { res, done };
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('RUNNING COMPREHENSIVE REPORT BUILDER ENHANCEMENTS TEST SUITE');
  console.log('================================================================\n');

  const gateMeta: GateMetadata = {
    id: 999,
    lcNumber: 'LC-TEST-01',
    name: 'Test Level Crossing',
    locationName: 'Ratlam Division',
    zone: 'Western Railway',
    division: 'Ratlam',
    scopeGroupName: 'Main Cluster'
  };

  // ─────────────────────────────────────────────────────────────────
  // TEST 1: Single completed OPEN -> CLOSED -> OPEN sequence counts as 1 cycle
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 1: Single completed cycle (OPEN -> CLOSED -> OPEN)');
  const test1Events = [
    {
      id: 1,
      gateId: 999,
      openedAt: new Date('2026-10-01T08:10:00+05:30'),
      closedAt: new Date('2026-10-01T08:15:00+05:30'),
      durationSeconds: 300,
      status: 'CLOSED'
    }
  ];
  const rep1 = calculateGateCycleAnalytics(gateMeta, test1Events, '2026-10-01', '2026-10-01');
  assert.strictEqual(rep1.kpis.totalCycles, 1, 'Should count exactly 1 cycle');
  assert.strictEqual(rep1.kpis.avgClosingSeconds, 300, 'Avg closing should be 300s (5m)');
  assert.strictEqual(rep1.kpis.avgClosingFormatted, '5m', 'Avg closing formatted should be 5m');
  assert.strictEqual(rep1.kpis.avgOpeningFormatted, '—', 'Avg opening formatted should be dash for single cycle');
  console.log('✔ TEST 1 PASSED: 1 completed cycle counted accurately.\n');

  // ─────────────────────────────────────────────────────────────────
  // TEST 2: Multiple completed cycles with consecutive opening intervals
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 2: Multiple completed cycles with average opening intervals');
  const test2Events = [
    // Cycle 1: 08:10 AM - 08:15 AM (5 min closed)
    {
      id: 1,
      gateId: 999,
      openedAt: new Date('2026-10-01T08:10:00+05:30'),
      closedAt: new Date('2026-10-01T08:15:00+05:30'),
      durationSeconds: 300,
      status: 'CLOSED'
    },
    // Cycle 2: 10:25 AM - 10:31 AM (6 min closed). Open interval from 08:15 to 10:25 = 130 min (7800s)
    {
      id: 2,
      gateId: 999,
      openedAt: new Date('2026-10-01T10:25:00+05:30'),
      closedAt: new Date('2026-10-01T10:31:00+05:30'),
      durationSeconds: 360,
      status: 'CLOSED'
    },
    // Cycle 3: 12:40 PM - 12:45 PM (5 min closed). Open interval from 10:31 to 12:40 = 129 min (7740s)
    {
      id: 3,
      gateId: 999,
      openedAt: new Date('2026-10-01T12:40:00+05:30'),
      closedAt: new Date('2026-10-01T12:45:00+05:30'),
      durationSeconds: 300,
      status: 'CLOSED'
    }
  ];
  const rep2 = calculateGateCycleAnalytics(gateMeta, test2Events, '2026-10-01', '2026-10-01');
  assert.strictEqual(rep2.kpis.totalCycles, 3, 'Should count 3 completed cycles');
  // Avg closing = (300 + 360 + 300) / 3 = 320s = 5m 20s
  assert.strictEqual(rep2.kpis.avgClosingSeconds, 320, 'Avg closing seconds should be 320');
  assert.strictEqual(rep2.kpis.avgClosingFormatted, '5m 20s', 'Avg closing formatted matches prompt formula');
  // Avg opening interval = (7800 + 7740) / 2 = 7770s = 129.5 min (~ 2h 9m 30s)
  assert.strictEqual(rep2.kpis.avgOpeningSeconds, 7770, 'Avg opening interval seconds matches consecutive pairs');
  console.log(`✔ TEST 2 PASSED: 3 cycles with Avg Closing ${rep2.kpis.avgClosingFormatted} and Avg Opening ${rep2.kpis.avgOpeningFormatted}.\n`);

  // ─────────────────────────────────────────────────────────────────
  // TEST 3: Incomplete, ongoing, and duplicate operations are safely handled
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 3: Incomplete/ongoing operations exclusion & duplicate handling');
  const test3Events = [
    // Completed cycle
    {
      id: 1,
      gateId: 999,
      openedAt: new Date('2026-10-01T08:10:00+05:30'),
      closedAt: new Date('2026-10-01T08:15:00+05:30'),
      durationSeconds: 300,
      status: 'CLOSED'
    },
    // Duplicate telemetry event (same openedAt within 1 second)
    {
      id: 2,
      gateId: 999,
      openedAt: new Date('2026-10-01T08:10:00.500+05:30'),
      closedAt: new Date('2026-10-01T08:15:00.500+05:30'),
      durationSeconds: 300,
      status: 'CLOSED'
    },
    // Ongoing operation (OPEN status, closedAt null) - MUST NOT BE COUNTED AS CYCLE
    {
      id: 3,
      gateId: 999,
      openedAt: new Date('2026-10-01T15:00:00+05:30'),
      closedAt: null,
      durationSeconds: null,
      status: 'OPEN'
    }
  ];
  const rep3 = calculateGateCycleAnalytics(gateMeta, test3Events, '2026-10-01', '2026-10-01');
  assert.strictEqual(rep3.kpis.totalCycles, 1, 'Duplicate and OPEN events must not artificially create cycles');
  console.log('✔ TEST 3 PASSED: Incomplete and duplicate events safely filtered out.\n');

  // ─────────────────────────────────────────────────────────────────
  // TEST 4: Cross-midnight operations attribution
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 4: Cross-midnight operation (starts 11:58 PM, ends 12:04 AM next day)');
  const test4Events = [
    {
      id: 1,
      gateId: 999,
      openedAt: new Date('2026-10-01T23:58:00+05:30'),
      closedAt: new Date('2026-10-02T00:04:00+05:30'),
      durationSeconds: 360,
      status: 'CLOSED'
    }
  ];
  const rep4 = calculateGateCycleAnalytics(gateMeta, test4Events, '2026-10-01', '2026-10-02');
  assert.strictEqual(rep4.kpis.totalCycles, 1, 'Should count 1 cycle');
  assert.strictEqual(rep4.kpis.avgClosingSeconds, 360, 'Full duration across midnight is 360s (6 min)');
  // Attributed to 2026-10-01
  const day1 = rep4.dailyBreakdown.find(d => d.dateStr === '2026-10-01');
  const day2 = rep4.dailyBreakdown.find(d => d.dateStr === '2026-10-02');
  assert.strictEqual(day1?.completedCycles, 1, 'Attributed to starting date in IST');
  assert.strictEqual(day2?.completedCycles, 0, 'Following day has 0 cycles attributed');
  console.log('✔ TEST 4 PASSED: Cross-midnight cycle attributed accurately without double-counting.\n');

  // ─────────────────────────────────────────────────────────────────
  // TEST 5: Dates with zero cycles display 0 and "—"
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 5: Zero cycle dates handling');
  const rep5 = calculateGateCycleAnalytics(gateMeta, [], '2026-10-01', '2026-10-03');
  assert.strictEqual(rep5.kpis.totalCycles, 0);
  assert.strictEqual(rep5.kpis.avgClosingFormatted, '—');
  assert.strictEqual(rep5.kpis.avgOpeningFormatted, '—');
  assert.strictEqual(rep5.dailyBreakdown.length, 3, 'Must contain all 3 days in range');
  rep5.dailyBreakdown.forEach(day => {
    assert.strictEqual(day.completedCycles, 0);
    assert.strictEqual(day.avgClosingFormatted, '—');
    assert.strictEqual(day.avgOpeningFormatted, '—');
    assert.strictEqual(day.totalOpenFormatted, '24h');
  });
  console.log('✔ TEST 5 PASSED: Empty dates render cleanly with zero counts and dashes.\n');

  // ─────────────────────────────────────────────────────────────────
  // TEST 6: Real Database Multi-Gate Cycle Analytics Integration
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 6: Real database multi-gate cycle analytics');
  const dbAnalytics = await getFullCycleAnalytics({
    targetGateIds: [((await prisma.lCGateEvent.findFirst({ select: { gateId: true } }))?.gateId ?? 186)],
    targetScopeGroupIds: [],
    startDateStr: '2026-10-25',
    endDateStr: '2026-10-31'
  });
  assert(dbAnalytics.overall.totalCycles > 0, 'Database real gate has real completed cycles');
  assert.strictEqual(dbAnalytics.gateReports.length, 1, '1 gate report returned');
  assert.strictEqual(dbAnalytics.gateReports[0].dailyBreakdown.length, 7, '7 days in daily breakdown');
  console.log(`✔ TEST 6 PASSED: Verified ${dbAnalytics.overall.totalCycles} cycles in DB for real gate.\n`);

  // ─────────────────────────────────────────────────────────────────
  // TEST 7: Export formats: Excel and PDF document generation
  // ─────────────────────────────────────────────────────────────────
  console.log('TEST 7: Excel and PDF exports binary compilation');
  const mockExcel = createMockResponse();
  exportCycleExcel(mockExcel.res as any, dbAnalytics, { filenameBase: 'cycle_test' });
  const excelResult = await mockExcel.done;
  assert(excelResult.buffer && excelResult.buffer.length > 1000, 'Excel buffer must be generated (> 1KB)');

  const mockPdf = createMockResponse();
  exportCyclePdf(mockPdf.res as any, dbAnalytics, { filenameBase: 'cycle_test' });
  const pdfResult = await mockPdf.done;
  assert(pdfResult.buffer && pdfResult.buffer.length > 50000, 'PDF buffer must be generated (> 50KB)');

  // Complete Log Report PDF & Excel
  const sampleLogData: CompleteLogReportData = {
    startDateStr: '2026-10-25',
    endDateStr: '2026-10-31',
    targetScopeGroupIds: [],
    targetGateIds: [((await prisma.lCGateEvent.findFirst({ select: { gateId: true } }))?.gateId ?? 186)],
    metrics: {
      totalOperations: 2,
      totalDurationSeconds: 600,
      totalDurationFormatted: '10m',
      avgDurationSeconds: 300,
      avgDurationFormatted: '5m',
      extendedDelaysCount: 0,
      currentlyOpenCount: 0,
      reportingGatesCount: 1
    },
    events: [
      {
        id: 101,
        gateId: 17,
        openedAt: new Date('2026-10-28T08:00:00+05:30'),
        closedAt: new Date('2026-10-28T08:05:00+05:30'),
        durationSeconds: 300,
        status: 'CLOSED',
        openedBy: 'Operator',
        closedBy: 'Operator',
        trainNumber: '12952',
        remarks: 'Normal clearance',
        gate: {
          id: 17,
          lcNumber: 'LC-M-001',
          locationName: 'Panvel',
          name: 'Panvel Gate',
          zone: 'Central Railway',
          division: 'Mumbai',
          scopeGroups: []
        }
      }
    ]
  };

  const cols = [
    { key: 'lcNumber', label: 'LC Number' },
    { key: 'openedDate', label: 'Date' },
    { key: 'openedTime', label: 'Opened (IST)' },
    { key: 'closedTime', label: 'Closed (IST)' },
    { key: 'durationFormatted', label: 'Duration' },
    { key: 'status', label: 'Status' }
  ];

  const mockLogExcel = createMockResponse();
  exportCompleteLogExcel(mockLogExcel.res as any, sampleLogData, cols, { filenameBase: 'log_test' });
  const logExcelResult = await mockLogExcel.done;
  assert(logExcelResult.buffer && logExcelResult.buffer.length > 1000, 'Complete Log Excel buffer valid');

  const mockLogPdf = createMockResponse();
  exportCompleteLogPdf(mockLogPdf.res as any, sampleLogData, cols, { filenameBase: 'log_test' });
  const logPdfResult = await mockLogPdf.done;
  assert(logPdfResult.buffer && logPdfResult.buffer.length > 50000, 'Complete Log PDF buffer valid');

  console.log('✔ TEST 7 PASSED: Excel and PDF generation verified for both report types.\n');

  console.log('================================================================');
  console.log('ALL 7 SUITES PASSED FLAWLESSLY!');
  console.log('================================================================');
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
}).finally(() => prisma.$disconnect());

