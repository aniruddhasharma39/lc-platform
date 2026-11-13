import { prisma } from '../src/lib/prisma';
import { getAttendanceReportData, getAttendanceExceptionReportData } from '../src/lib/attendanceReportService';
import {
  exportAttendanceExcel,
  exportAttendancePdf,
  exportAttendanceExceptionExcel,
  exportAttendanceExceptionPdf,
} from '../src/lib/reportExporter';

function createMockRes(type: string) {
  let sentLength = 0;
  const resObj: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    setHeader: (k: string, v: string) => { resObj.headers[k] = v; },
    header: (k: string, v: string) => { resObj.headers[k] = v; },
    status: (code: number) => { resObj.statusCode = code; return resObj; },
    attachment: (filename: string) => { resObj.headers['Content-Disposition'] = `attachment; filename="${filename}"`; },
    contentType: (type: string) => { resObj.headers['Content-Type'] = type; },
    send: (content: any) => {
      sentLength = content ? content.length : 0;
      console.log(`  ✅ ${type} send: ${sentLength} bytes`);
    },
    write: (chunk: any) => {
      sentLength += chunk ? (chunk.length || 0) : 0;
      return true;
    },
    end: (finalChunk?: any) => {
      if (finalChunk) sentLength += (finalChunk.length || 0);
      console.log(`  ✅ ${type} stream finished: ${sentLength} bytes`);
    },
    on: () => resObj,
    once: () => resObj,
    emit: () => true,
  };
  return resObj;
}

async function runTest() {
  console.log('🧪 Starting Attendance & Exception Reports Verification...');

  // 1. Find a test admin or PWI user
  const admin = await prisma.user.findFirst({
    where: { role: { name: 'SuperAdmin' } },
    include: { role: true },
  });

  const requestingUser = admin || { id: 1, role: { name: 'SuperAdmin' } };
  console.log(`👤 Requesting user: ${requestingUser.id} (${(requestingUser as any).role?.name})`);

  // 2. Test Attendance Muster Report
  console.log('\n--- 1. Testing getAttendanceReportData ---');
  const attendanceData = await getAttendanceReportData({}, requestingUser);
  console.log('✅ Attendance Report Data fetched successfully:');
  console.log(`   - Date range: ${attendanceData.startDateStr} to ${attendanceData.endDateStr}`);
  console.log(`   - Total sessions: ${attendanceData.metrics.totalSessions}`);
  console.log(`   - Completed: ${attendanceData.metrics.completedSessions}`);
  console.log(`   - Currently on duty: ${attendanceData.metrics.currentlyOnDuty}`);
  console.log(`   - Late sessions: ${attendanceData.metrics.lateSessions}`);
  console.log(`   - On-time percentage: ${attendanceData.metrics.onTimePercentage}%`);
  console.log(`   - Total records: ${attendanceData.records.length}`);

  // 3. Test Attendance Exception Report
  console.log('\n--- 2. Testing getAttendanceExceptionReportData ---');
  const exceptionData = await getAttendanceExceptionReportData({}, requestingUser);
  console.log('✅ Exception Report Data fetched successfully:');
  console.log(`   - Date range: ${exceptionData.startDateStr} to ${exceptionData.endDateStr}`);
  console.log(`   - Total exceptions: ${exceptionData.metrics.totalExceptions}`);
  console.log(`   - Late arrivals: ${exceptionData.metrics.lateArrivalsCount}`);
  console.log(`   - Unstaffed gates: ${exceptionData.metrics.unstaffedGateCount}`);
  console.log(`   - Geofence breaches: ${exceptionData.metrics.geofenceBreachCount}`);
  console.log(`   - Total delay minutes: ${exceptionData.metrics.totalDelayMinutes} mins`);
  console.log(`   - Compliance score: ${exceptionData.metrics.safetyComplianceScore}%`);
  console.log(`   - Total exception records: ${exceptionData.exceptions.length}`);

  // 4. Test Exporters
  console.log('\n--- 3. Testing Attendance Exporters ---');
  const mockRes1 = createMockRes('Attendance Excel');
  await exportAttendanceExcel(mockRes1, attendanceData, { filenameBase: 'Test_Attendance' });

  const mockRes2 = createMockRes('Attendance PDF');
  await exportAttendancePdf(mockRes2, attendanceData, { filenameBase: 'Test_Attendance' });

  console.log('\n--- 4. Testing Attendance Exception Exporters ---');
  const mockRes3 = createMockRes('Attendance Exception Excel');
  await exportAttendanceExceptionExcel(mockRes3, exceptionData, { filenameBase: 'Test_Attendance_Exception' });

  const mockRes4 = createMockRes('Attendance Exception PDF');
  await exportAttendanceExceptionPdf(mockRes4, exceptionData, { filenameBase: 'Test_Attendance_Exception' });

  console.log('\n🎉 ALL ATTENDANCE REPORT & EXPORTER TESTS PASSED!');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
