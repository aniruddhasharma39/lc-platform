import { prisma } from '../src/lib/prisma';
import {
  getRekognitionClient,
  DEFAULT_COLLECTION_ID,
  DEFAULT_SIMILARITY_THRESHOLD,
  ensureCollectionExists,
} from '../src/lib/rekognitionClient';

async function main() {
  console.log('========================================================================');
  console.log('🚀 RUNNING PHASE 1 FACIAL ATTENDANCE & AWS REKOGNITION VERIFICATION');
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
      process.exitCode = 1;
    }
  }

  // 1. Prisma Schema & User Biometric Fields
  console.log('--- 1. User Model Biometric & Enrollment Fields ---');
  const user = await prisma.user.findFirst();
  assert(user !== null, 'Found existing user in database');
  assert('isFaceEnrolled' in (user || {}), 'User model has field "isFaceEnrolled"');
  assert('faceId' in (user || {}), 'User model has field "faceId"');
  assert('faceImageKey' in (user || {}), 'User model has field "faceImageKey"');
  assert('faceEnrolledAt' in (user || {}), 'User model has field "faceEnrolledAt"');
  assert('faceEnrollConfidence' in (user || {}), 'User model has field "faceEnrollConfidence"');
  assert('faceLockoutUntil' in (user || {}), 'User model has field "faceLockoutUntil"');

  // 2. ShiftAttendance Model & Schema Verification
  console.log('\n--- 2. ShiftAttendance Table & Database Relations ---');
  const station = await prisma.station.findFirst({
    where: { gates: { some: {} } },
    include: { gates: true }
  });
  assert(!!station, 'Found station with LC gates in database');

  const gate = station!.gates[0];
  assert(!!gate, `Found LC Gate: ${gate?.locationName || gate?.lcNumber}`);

  const gateman = await prisma.user.findFirst({
    where: { status: 'APPROVED' }
  });
  assert(!!gateman, `Found test user: ${gateman?.fullName}`);

  // Test creating a ShiftAttendance entry
  const testAttendance = await prisma.shiftAttendance.create({
    data: {
      userId: gateman!.id,
      gateId: gate.id,
      stationId: station!.id,
      date: '2026-11-25',
      shiftName: 'Morning Shift (06:00 - 14:00)',
      type: 'CHECK_IN',
      latitude: gate.latitude || 25.5941,
      longitude: gate.longitude || 85.1376,
      distanceMeters: 24.5,
      geofencePassed: true,
      similarityScore: 98.4,
      livenessPassed: true,
      status: 'PRESENT',
      minutesLate: 0,
      selfieUrl: 'uploads/attendance/test_selfie.jpg',
    }
  });

  assert(testAttendance.id > 0, 'ShiftAttendance record created successfully');
  assert(testAttendance.geofencePassed === true, 'Geofence verification flag persisted (distance: 24.5m)');
  assert(testAttendance.similarityScore === 98.4, 'Rekognition similarity score persisted (98.4%)');
  assert(testAttendance.status === 'PRESENT', 'Attendance status correctly marked as PRESENT');

  // Test relational queries
  const userWithAttendance = await prisma.user.findUnique({
    where: { id: gateman!.id },
    include: { shiftAttendances: true }
  });
  assert(
    (userWithAttendance?.shiftAttendances.length || 0) > 0,
    'User -> shiftAttendances reverse relation working'
  );

  const gateWithAttendance = await prisma.lCGate.findUnique({
    where: { id: gate.id },
    include: { shiftAttendances: true }
  });
  assert(
    (gateWithAttendance?.shiftAttendances.length || 0) > 0,
    'LCGate -> shiftAttendances reverse relation working'
  );

  // 3. FaceReenrollmentRequest Model Verification
  console.log('\n--- 3. FaceReenrollmentRequest Model Verification ---');
  const reenrollRequest = await prisma.faceReenrollmentRequest.create({
    data: {
      userId: gateman!.id,
      reason: 'Facial injury recovery and new glasses prescribed by CMS.',
      status: 'PENDING',
    }
  });

  assert(reenrollRequest.id > 0, 'FaceReenrollmentRequest created with PENDING status');
  assert(reenrollRequest.reason.includes('Facial injury'), 'Re-enrollment justification stored');

  // Test updating status to APPROVED
  const updatedRequest = await prisma.faceReenrollmentRequest.update({
    where: { id: reenrollRequest.id },
    data: {
      status: 'APPROVED',
      reviewedById: gateman!.id,
      reviewedAt: new Date(),
    }
  });
  assert(updatedRequest.status === 'APPROVED', 'Face re-enrollment request successfully updated to APPROVED');

  // 4. AWS Rekognition Service Configuration & Client
  console.log('\n--- 4. AWS Rekognition Client & Service Architecture ---');
  const client = getRekognitionClient();
  assert(!!client, 'AWS RekognitionClient successfully instantiated');
  assert(DEFAULT_COLLECTION_ID === 'lc-gate-staff-collection', `Default collection ID configured: "${DEFAULT_COLLECTION_ID}"`);
  assert(DEFAULT_SIMILARITY_THRESHOLD === 95.0, `Strict biometric threshold enforced: ${DEFAULT_SIMILARITY_THRESHOLD}%`);

  // 5. Clean up test records
  console.log('\n--- 5. Clean Up Verification Data ---');
  await prisma.shiftAttendance.delete({ where: { id: testAttendance.id } });
  await prisma.faceReenrollmentRequest.delete({ where: { id: reenrollRequest.id } });
  console.log('  🧹 Test attendance and re-enrollment records cleaned up');

  console.log('\n========================================================================');
  console.log(`🎉 PHASE 1 VERIFICATION COMPLETE: ${passed}/${total} TESTS PASSED!`);
  console.log('========================================================================\n');
}

main()
  .catch(e => {
    console.error('Phase 1 attendance verification failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
