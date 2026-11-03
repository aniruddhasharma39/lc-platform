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
  assert(countData.zones.length > 0, 'Must have aggregated zone items');

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

  assert(durationData.kpis.totalOpenSeconds > 0, 'Total open seconds must be > 0');
  assert(durationData.kpis.totalClosedSeconds > 0, 'Total closed seconds must be > 0');
  assert(durationData.kpis.totalCompletedCycles > 0, 'Total completed cycles must be > 0');
  assert(durationData.gates.length === allGateIds.length, 'All gates must have duration metrics');

  for (const g of durationData.gates) {
    assert(g.dailyBreakdown.length > 0, `Gate ${g.lcNumber} must have daily breakdown metrics`);
    assert(typeof g.totalOpenFormatted === 'string', 'Must have formatted open duration');
    assert(typeof g.totalClosedFormatted === 'string', 'Must have formatted closed duration');
  }

  console.log(`✅ TEST 2 PASSED: Duration Report computed ${durationData.kpis.totalOpenFormatted} open duration, ${durationData.kpis.avgOpenFormatted} avg open duration.`);

  // --------------------------------------------------------------------------
  // TEST 3: Holistic Management Report (Consolidated Hierarchy)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Holistic Management Report (Consolidated Hierarchy) ---');
  const holisticData = await getHolisticReportAnalytics({
    targetGateIds: allGateIds,
    startDateStr: defaultStart,
    endDateStr: defaultEnd
  });

  assert(holisticData.kpis.totalGates === allGateIds.length, 'Holistic gates count must match target gates');
  assert(holisticData.hierarchy.length > 0, 'Hierarchy must contain Zone-level nodes');
  assert(holisticData.flatStations.length > 0, 'Must contain flat station list for comparative view');
  assert(holisticData.flatGates.length === allGateIds.length, 'Must contain flat gates list');

  // Verify hierarchy traversal: Zone -> Division -> Station -> Gate
  for (const zn of holisticData.hierarchy) {
    assert(zn.zone, 'Zone must have name');
    assert(zn.divisions.length > 0, 'Zone must contain divisions');
    for (const div of zn.divisions) {
      assert(div.division, 'Division must have name');
      assert(div.stations.length > 0, 'Division must contain stations');
      for (const st of div.stations) {
        assert(st.stationName, 'Station must have name');
        assert(st.gates.length > 0, 'Station must contain gates');
        for (const g of st.gates) {
          assert(g.lcNumber, 'Gate must have LC number');
          assert(g.totalOperations > 0, 'Gate must have positive operations');
        }
      }
    }
  }

  console.log(`✅ TEST 3 PASSED: Holistic Hierarchy validated: ${holisticData.kpis.totalZones} Zones -> ${holisticData.kpis.totalDivisions} Divisions -> ${holisticData.kpis.totalStations} Stations -> ${holisticData.kpis.totalGates} LC Gates.`);

  // --------------------------------------------------------------------------
  // TEST 4: Role-Based Divisional Scoping (Pune Division Only)
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
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ TEST FAILED:', err);
    process.exit(1);
  });
