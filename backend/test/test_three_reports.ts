import assert from 'assert';
import { prisma } from '../src/lib/prisma';
import {
  getCountReportAnalytics,
  getDurationReportAnalytics,
  getHolisticReportAnalytics
} from '../src/lib/cycleReportService';

async function runTests() {
  console.log('==================================================================');
  console.log('🧪 RUNNING TEST SUITE: Count, Duration & Holistic Report Analytics');
  console.log('==================================================================');

  const gates = await prisma.lCGate.findMany({
    include: { station: true }
  });
  const allGateIds = gates.map(g => g.id);
  const puneGates = gates.filter(g => (g.division || '').toLowerCase().includes('pune'));
  const puneGateIds = puneGates.map(g => g.id);

  assert(gates.length >= 4, 'Must have at least 4 gates for multi-division tests');
  assert(puneGateIds.length >= 2, 'Must have at least 2 gates in Pune division');

  const today = new Date();
  const defaultEnd = today.toISOString().split('T')[0];
  const defaultStartObj = new Date(today);
  defaultStartObj.setDate(today.getDate() - 30);
  const defaultStart = defaultStartObj.toISOString().split('T')[0];

  // Seed temporary scoped test events
  const testEventsData = [];
  for (const g of gates) {
    for (let i = 0; i < 5; i++) {
      const openTime = new Date(Date.now() - (i + 1) * 3600 * 1000);
      const closeTime = new Date(openTime.getTime() + 120 * 1000);
      testEventsData.push({
        gateId: g.id,
        openedAt: openTime,
        closedAt: closeTime,
        durationSeconds: 120,
        status: 'CLOSED',
        openedBy: 'Test Auto',
        closedBy: 'Test Auto',
        remarks: 'Automated Test Event'
      });
    }
  }
  await prisma.lCGateEvent.createMany({ data: testEventsData });

  try {
    // --------------------------------------------------------------------------
    // TEST 1: Count Report Analytics
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 1: Count Report Analytics ---');
    const countData = await getCountReportAnalytics({
      targetGateIds: allGateIds,
      startDateStr: defaultStart,
      endDateStr: defaultEnd
    });

    assert(countData.kpis.totalOperations > 0, 'Total operations must be > 0');
    assert(countData.kpis.totalOpenCount > 0, 'Total open count must be > 0');
    assert(countData.kpis.totalCloseCount > 0, 'Total close count must be > 0');
    assert.strictEqual(
      countData.kpis.totalOperations,
      countData.kpis.totalOpenCount + countData.kpis.totalCloseCount,
      'Total operations must equal openCount + closeCount'
    );
    assert(countData.gates.length === allGateIds.length, 'All requested gates must be represented');
    assert(countData.stations.length > 0, 'Must have aggregated station items');
    assert(countData.divisions.length > 0, 'Must have aggregated division items');

    console.log(`✅ TEST 1 PASSED: Count Report computed ${countData.kpis.totalOperations} operations across ${countData.gates.length} gates, ${countData.stations.length} stations, ${countData.divisions.length} divisions.`);

    // --------------------------------------------------------------------------
    // TEST 2: Duration Report Analytics
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 2: Duration Report Analytics ---');
    const durationData = await getDurationReportAnalytics({
      targetGateIds: allGateIds,
      startDateStr: defaultStart,
      endDateStr: defaultEnd
    });

    assert(durationData.kpis.totalOpenSeconds > 0, 'Total open duration must be > 0');
    assert(durationData.kpis.avgOpenSeconds > 0, 'Average open duration must be > 0');
    assert(durationData.gates[0].dailyBreakdown.length > 0, 'Daily breakdown must not be empty');
    assert(durationData.gates.length === allGateIds.length, 'All requested gates must be present in duration report');

    console.log(`✅ TEST 2 PASSED: Duration Report computed ${durationData.kpis.totalOpenFormatted} open duration, ${durationData.kpis.avgOpenFormatted} avg open duration.`);

    // --------------------------------------------------------------------------
    // TEST 3: Holistic Report Analytics (Consolidated Hierarchy)
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 3: Holistic Management Report (Consolidated Hierarchy) ---');
    const holisticData = await getHolisticReportAnalytics({
      targetGateIds: allGateIds,
      startDateStr: defaultStart,
      endDateStr: defaultEnd
    });

    assert(holisticData.kpis.totalOperations > 0, 'Holistic operations must be > 0');
    assert.strictEqual(holisticData.kpis.totalGates, allGateIds.length, 'Holistic totalGates must equal input count');
    assert(holisticData.hierarchy.length > 0, 'Hierarchy zones must not be empty');
    assert(holisticData.hierarchy[0].divisions.length > 0, 'Hierarchy divisions must not be empty');
    assert(holisticData.hierarchy[0].divisions[0].stations.length > 0, 'Hierarchy stations must not be empty');
    assert(holisticData.hierarchy[0].divisions[0].stations[0].gates.length > 0, 'Hierarchy gates must not be empty');

    let totalHierarchyGates = 0;
    for (const z of holisticData.hierarchy) {
      for (const d of z.divisions) {
        for (const s of d.stations) {
          totalHierarchyGates += s.gates.length;
        }
      }
    }
    assert.strictEqual(totalHierarchyGates, allGateIds.length, 'Sum of all gates in hierarchy must equal total gates');

    console.log(`✅ TEST 3 PASSED: Holistic Hierarchy validated: ${holisticData.hierarchy.length} Zones -> ${holisticData.hierarchy.reduce((acc, z) => acc + z.divisions.length, 0)} Divisions -> ${holisticData.hierarchy.reduce((acc, z) => acc + z.divisions.reduce((sAcc, d) => sAcc + d.stations.length, 0), 0)} Stations -> ${totalHierarchyGates} LC Gates.`);

    // --------------------------------------------------------------------------
    // TEST 4: Role-Based Divisional Scoping
    // --------------------------------------------------------------------------
    console.log('\n--- TEST 4: Role-Based Divisional Scoping (Pune Division Only) ---');
    const puneHolistic = await getHolisticReportAnalytics({
      targetGateIds: puneGateIds,
      startDateStr: defaultStart,
      endDateStr: defaultEnd
    });

    assert.strictEqual(puneHolistic.kpis.totalGates, puneGateIds.length, 'Pune report must strictly include Pune gates only');
    assert(puneHolistic.hierarchy.every(z => z.divisions.every(d => d.division.toLowerCase().includes('pune'))), 'Pune report must strictly contain Pune division');
    assert(!puneHolistic.flatGates.some(g => (g.division || '').toLowerCase().includes('mumbai')), 'Mumbai gates must NOT be in Pune report');

    console.log(`✅ TEST 4 PASSED: Divisional scoping strictly enforces Pune gate boundaries.`);

    console.log('\n==================================================================');
    console.log('🎉 ALL 3 REPORT SUITES PASSED SUCCESSFULLY (4/4)!');
    console.log('==================================================================');
  } finally {
    // Clean up temporary test events completely
    await prisma.lCGateEvent.deleteMany({ where: { remarks: 'Automated Test Event' } });
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  });
