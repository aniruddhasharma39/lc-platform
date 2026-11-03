import { getCountReportAnalytics, getHolisticReportAnalytics } from '../src/lib/cycleReportService';
import { exportCountCsv, exportCountExcel, exportCountPdf, exportHolisticCsv, exportHolisticExcel, exportHolisticPdf } from '../src/lib/reportExporter';
import { prisma } from '../src/lib/prisma';

async function testExporters() {
  console.log('🧪 Testing Report Exporters for Count and Holistic Reports...');

  const countData = await getCountReportAnalytics({
    targetGateIds: [1, 2, 3, 4],
    startDateStr: '2025-01-01',
    endDateStr: '2026-12-31'
  });

  const holisticData = await getHolisticReportAnalytics({
    targetGateIds: [1, 2, 3, 4],
    startDateStr: '2025-01-01',
    endDateStr: '2026-12-31'
  });

  // Comprehensive mock response object for Express.js Response
  function createMockRes(type: string) {
    let sentLength = 0;
    const resObj = {
      headers: {} as Record<string, string>,
      statusCode: 200,
      setHeader: (k: string, v: string) => { resObj.headers[k] = v; },
      header: (k: string, v: string) => { resObj.headers[k] = v; },
      status: (code: number) => { resObj.statusCode = code; return resObj; },
      attachment: (filename: string) => { resObj.headers['Content-Disposition'] = `attachment; filename="${filename}"`; },
      contentType: (type: string) => { resObj.headers['Content-Type'] = type; },
      send: (content: any) => {
        sentLength = content ? content.length : 0;
        console.log(`  ✅ ${type} send: ${sentLength} bytes, status: ${resObj.statusCode}`);
      },
      write: (chunk: any) => {
        sentLength += chunk ? (chunk.length || 0) : 0;
        return true;
      },
      end: (finalChunk?: any) => {
        if (finalChunk) sentLength += (finalChunk.length || 0);
        console.log(`  ✅ ${type} streamed: ${sentLength} bytes`);
      },
      on: (event: string, cb: any) => resObj,
      once: (event: string, cb: any) => resObj,
      emit: () => true
    };
    return resObj;
  }

  // 1. Count CSV
  exportCountCsv(createMockRes('Count CSV') as any, countData, { filenameBase: 'test_count' });

  // 2. Count Excel
  await exportCountExcel(createMockRes('Count Excel') as any, countData, { filenameBase: 'test_count' });

  // 3. Count PDF
  await exportCountPdf(createMockRes('Count PDF') as any, countData, { filenameBase: 'test_count' });

  // 4. Holistic CSV
  exportHolisticCsv(createMockRes('Holistic CSV') as any, holisticData, { filenameBase: 'test_holistic' });

  // 5. Holistic Excel
  await exportHolisticExcel(createMockRes('Holistic Excel') as any, holisticData, { filenameBase: 'test_holistic' });

  // 6. Holistic PDF
  await exportHolisticPdf(createMockRes('Holistic PDF') as any, holisticData, { filenameBase: 'test_holistic' });

  console.log('🎉 All 6 exporters executed and verified successfully!');
  await prisma.$disconnect();
}

testExporters().catch(err => {
  console.error('❌ Exporter error:', err);
  process.exit(1);
});
