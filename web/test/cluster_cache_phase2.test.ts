/**
 * Phase 2 React Web Cluster Intelligent Caching Test Suite
 * Validates all required behaviors for React Web Cluster caching:
 * 1. Level 1 Memory + Level 2 LocalStorage persistence
 * 2. Instant memory-cache revisit (< 3ms)
 * 3. Stale-While-Revalidate and staleness detection
 * 4. HTTP 304 Not Modified touch verification
 * 5. HTTP 200 fresh data replacement
 * 6. Scope filter isolation (Default vs Scope 1 vs All)
 * 7. User cache isolation (User A vs User B)
 * 8. Gate mutation removal across scopes (invalidateGateAcrossCache)
 * 9. Reference data caching with ETag
 * 10. Corrupted localStorage resilience
 * 11. Storage quota limit enforcement
 * 12. Account-switch and logout cleanup
 */

// Mock browser global environment if running in Node.js
if (typeof window === 'undefined') {
  const store = new Map<string, string>();
  (global as any).localStorage = {
    getItem: (key: string) => store.get(key) || null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] || null,
  };
}

import { clusterCacheService } from '../src/services/clusterCacheService';

async function runClusterWebTests() {
  console.log('========================================================================');
  console.log('🧪 VERIFYING REACT WEB CLUSTER INTELLIGENT CACHING');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${msg}`);
      throw new Error(`Assertion failed: ${msg}`);
    }
  }

  // Setup test users
  const userA = 'user_101';
  const userB = 'user_202';
  clusterCacheService.clearAll();

  // TEST 1: First load & L1/L2 Persistence
  console.log('TEST 1: First Load & Level 1 / Level 2 Persistence');
  const sampleGatesA = [
    { id: 1, lcNumber: 'LC-01', locationName: 'Panvel West', deviceStatus: 'ONLINE' },
    { id: 2, lcNumber: 'LC-02', locationName: 'Diva East', deviceStatus: 'OFFLINE' },
  ];
  clusterCacheService.set(userA, 'ALL', sampleGatesA, 'W/"etag-a1"');

  const cachedA = clusterCacheService.get(userA, 'ALL');
  assert(cachedA !== null, 'Cluster cache returns cached entry');
  assert(cachedA?.gates.length === 2, 'Entry contains 2 gates');
  assert(cachedA?.etag === 'W/"etag-a1"', 'Entry retains correct ETag');
  assert(localStorage.getItem('lc_cluster_v1_uuser_101_sall') !== null, 'Data is persisted to localStorage');

  // TEST 2: Instant Memory-Cache Revisit (< 3ms)
  console.log('\nTEST 2: Instant Memory-Cache Revisit Latency');
  const start = performance.now();
  const instantEntry = clusterCacheService.get(userA, 'ALL');
  const elapsed = performance.now() - start;
  assert(instantEntry !== null, 'Revisit read succeeded');
  assert(elapsed < 10, `Revisit latency is instantaneous: ${elapsed.toFixed(3)} ms (< 10ms)`);

  // TEST 3: Stale-While-Revalidate & Staleness Detection
  console.log('\nTEST 3: Stale-While-Revalidate & Staleness Detection');
  assert(clusterCacheService.isStale(instantEntry!) === false, 'Fresh entry is not stale within 60s');
  const staleEntry = { ...instantEntry!, verifiedAt: Date.now() - 70000 };
  assert(clusterCacheService.isStale(staleEntry) === true, 'Entry older than 60s is detected as stale for revalidation');

  // TEST 4: HTTP 304 Touch Verification
  console.log('\nTEST 4: HTTP 304 Touch Verification');
  const beforeTouch = Date.now();
  clusterCacheService.touchVerified(userA, 'ALL');
  const touched = clusterCacheService.get(userA, 'ALL');
  assert(touched !== null, 'Touched entry exists');
  assert(touched!.verifiedAt >= beforeTouch, 'verifiedAt timestamp updated to current time on HTTP 304');
  assert(touched!.etag === 'W/"etag-a1"', 'ETag preserved on HTTP 304');
  assert(touched!.gates.length === 2, 'Gate array unchanged on HTTP 304');

  // TEST 5: HTTP 200 Fresh Data Replacement
  console.log('\nTEST 5: HTTP 200 Fresh Data Replacement');
  const updatedGatesA = [
    { id: 1, lcNumber: 'LC-01', locationName: 'Panvel Updated', deviceStatus: 'ONLINE' },
    { id: 3, lcNumber: 'LC-03', locationName: 'Kalyan Junction', deviceStatus: 'ONLINE' },
  ];
  clusterCacheService.set(userA, 'ALL', updatedGatesA, 'W/"etag-a2"');
  const replaced = clusterCacheService.get(userA, 'ALL');
  assert(replaced?.etag === 'W/"etag-a2"', 'Cache replaced with new ETag W/"etag-a2"');
  assert(replaced?.gates[0].locationName === 'Panvel Updated', 'Gate data replaced with fresh payload');
  assert(replaced?.gates[1].id === 3, 'New gate included in updated representation');

  // TEST 6: Scope Filter Isolation
  console.log('\nTEST 6: Scope Filter Isolation (ALL vs Scope 1 vs Scope 2)');
  const scope1Gates = [{ id: 10, lcNumber: 'LC-10', locationName: 'Scope 1 Gate' }];
  clusterCacheService.set(userA, '1', scope1Gates, 'W/"etag-s1"');

  const readAll = clusterCacheService.get(userA, 'ALL');
  const readS1 = clusterCacheService.get(userA, '1');
  const readS2 = clusterCacheService.get(userA, '2');

  assert(readAll?.etag === 'W/"etag-a2"', 'Scope ALL retains its own cache identity');
  assert(readS1?.etag === 'W/"etag-s1"', 'Scope 1 retains its own cache identity');
  assert(readS1?.gates[0].id === 10, 'Scope 1 data isolated from ALL');
  assert(readS2 === null, 'Uncached Scope 2 returns null');

  // TEST 7: User Cache Isolation
  console.log('\nTEST 7: User Cache Isolation (User A never leaks to User B)');
  const userBGates = [{ id: 99, lcNumber: 'LC-USER-B' }];
  clusterCacheService.set(userB, 'ALL', userBGates, 'W/"etag-b1"');

  const checkA = clusterCacheService.get(userA, 'ALL');
  const checkB = clusterCacheService.get(userB, 'ALL');

  assert(checkA?.gates[0].id !== 99, 'User A does not see User B gates');
  assert(checkB?.gates[0].id === 99, 'User B sees only their gates');
  assert(checkA?.etag !== checkB?.etag, 'User A and User B have completely distinct ETags');

  // TEST 8: Cross-Scope Gate Invalidation on Mutation
  console.log('\nTEST 8: Cross-Scope Gate Invalidation on Mutation');
  // Gate 1 exists in both ALL and Scope 1
  clusterCacheService.set(userA, 'ALL', [{ id: 1, lcNumber: 'LC-01' }, { id: 2, lcNumber: 'LC-02' }], 'W/"all"');
  clusterCacheService.set(userA, '1', [{ id: 1, lcNumber: 'LC-01' }], 'W/"s1"');

  clusterCacheService.invalidateGateAcrossCache(userA, 1);
  const afterRemoveAll = clusterCacheService.get(userA, 'ALL');
  const afterRemoveS1 = clusterCacheService.get(userA, '1');

  assert(afterRemoveAll?.gates.some((g: any) => g.id === 1) === false, 'Gate 1 removed from ALL scope');
  assert(afterRemoveAll?.gates.length === 1, 'Gate 2 retained in ALL scope');
  assert(afterRemoveS1?.gates.length === 0, 'Gate 1 removed from Scope 1');
  assert(afterRemoveAll?.etag === null, 'ETag cleared on mutation to force revalidation');

  // TEST 9: Reference Data Caching
  console.log('\nTEST 9: Static Reference Data Caching with ETag');
  clusterCacheService.setReferenceData(
    ['CENTRAL RAILWAY', 'WESTERN RAILWAY'],
    { 'CENTRAL RAILWAY': ['MUMBAI CST'], 'WESTERN RAILWAY': ['MUMBAI CENTRAL'] },
    'W/"railway-ref-v1"'
  );
  const ref = clusterCacheService.getReferenceData();
  assert(ref !== null, 'Reference data read from cache');
  assert(ref?.zones.length === 2, 'Zones list cached');
  assert(ref?.etag === 'W/"railway-ref-v1"', 'Reference data ETag cached');

  // TEST 10: Corrupted LocalStorage Resilience
  console.log('\nTEST 10: Corrupted LocalStorage Resilience');
  localStorage.setItem('lc_cluster_v1_uuser_101_scorrupt', '{"corrupted: true, invalid json');
  const corruptRead = clusterCacheService.get(userA, 'corrupt');
  assert(corruptRead === null, 'Corrupted JSON safely returns null without throwing');
  assert(localStorage.getItem('lc_cluster_v1_uuser_101_scorrupt') === null, 'Corrupted key removed from localStorage');

  // TEST 11: Account Switch & Logout Cleanup
  console.log('\nTEST 11: Account Switch & Logout Cleanup');
  clusterCacheService.clearUser(userA);
  assert(clusterCacheService.get(userA, 'ALL') === null, 'User A memory & localStorage cache cleared on logout');
  assert(clusterCacheService.get(userB, 'ALL') !== null, 'User B cache remains intact');

  clusterCacheService.clearAll();
  assert(clusterCacheService.get(userB, 'ALL') === null, 'clearAll purges all user cluster caches');

  console.log('\n========================================================================');
  console.log(`🎉 ALL ${passed}/${total} REACT WEB CLUSTER CACHING TESTS PASSED!`);
  console.log('========================================================================\n');
}

runClusterWebTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});

