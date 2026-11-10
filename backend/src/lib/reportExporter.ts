import { Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import {
  FullCycleAnalyticsResponse,
  GateCycleReport,
  getISTDateString,
  formatISTDateDisplay,
  formatDurationHuman,
  CountReportResponse,
  DurationReportResponse,
  HolisticReportResponse
} from './cycleReportService';

export interface CompleteLogReportData {
  startDateStr: string;
  endDateStr: string;
  targetScopeGroupIds: number[];
  targetGateIds: number[];
  metrics: {
    totalOperations: number;
    totalDurationSeconds: number;
    totalDurationFormatted: string;
    avgDurationSeconds: number;
    avgDurationFormatted: string;
    extendedDelaysCount: number;
    currentlyOpenCount: number;
    reportingGatesCount: number;
  };
  events: Array<{
    id: number;
    gateId: number;
    masterId?: number | null;
    masterSerial?: string | null;
    thingName?: string | null;
    openedAt: Date;
    closedAt: Date | null;
    durationSeconds: number | null;
    status: string;
    openedBy: string | null;
    closedBy: string | null;
    trainNumber: string | null;
    remarks: string | null;
    gate: {
      id: number;
      lcNumber: string;
      locationName: string;
      name: string | null;
      zone: string | null;
      division: string | null;
      scopeGroups: Array<{
        scopeGroup: { id: number; name: string; color: string | null };
      }>;
    };
  }>;
}

export interface ActiveColumn {
  key: string;
  label: string;
}

function buildCompleteLogRowMap(
  ev: CompleteLogReportData['events'][number],
  gate: { scopeGroupName: string; lcNumber: string; locationName: string; zone: string | null; division: string | null }
): Record<string, any> {
  const openedDateObj = new Date(ev.openedAt);
  const openedDateStr = openedDateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  const openedTimeStr = openedDateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const closedTimeStr = ev.closedAt
    ? new Date(ev.closedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
    : 'STILL OPEN';

  return {
    scopeGroup: gate.scopeGroupName,
    lcNumber: gate.lcNumber,
    masterUnit: ev.masterSerial || ev.thingName || '-',
    locationName: gate.locationName,
    zone: gate.zone || '-',
    division: gate.division || '-',
    openedDate: openedDateStr,
    openedTime: openedTimeStr,
    closedTime: closedTimeStr,
    durationFormatted: ev.durationSeconds ? formatDurationHuman(ev.durationSeconds) : 'In Progress',
    durationSeconds: ev.durationSeconds ? String(ev.durationSeconds) : '-',
    status: ev.status,
  };
}

// Color Palette
const NAVY_BLUE = '#003580';
const SAFFRON = '#FF6600';
const DEEP_GREEN = '#046A38';
const GOLDEN_SAND = '#E8D5A3';
const HEADER_BG = '#1E293B';
const ZEBRA_BG = '#F8FAFC';
const BORDER_COLOR = '#CBD5E1';

function resolveLogos() {
  const irLogoPath = [
    path.join(__dirname, '../../assets/ir_logo.png'),
    path.join(__dirname, '../assets/ir_logo.png'),
    path.join(process.cwd(), 'assets/ir_logo.png'),
    path.join(process.cwd(), 'backend/assets/ir_logo.png'),
    path.join(__dirname, '../../assets/ir_logo.jpg'),
    path.join(__dirname, '../assets/ir_logo.jpg'),
    path.join(process.cwd(), 'assets/ir_logo.jpg'),
    path.join(process.cwd(), 'backend/assets/ir_logo.jpg'),
  ].find(p => p && fs.existsSync(p));

  const azadiLogoPath = [
    path.join(__dirname, '../../assets/azadi_logo.png'),
    path.join(__dirname, '../assets/azadi_logo.png'),
    path.join(process.cwd(), 'assets/azadi_logo.png'),
    path.join(process.cwd(), 'backend/assets/azadi_logo.png'),
  ].find(p => p && fs.existsSync(p));

  return { irLogoPath, azadiLogoPath };
}

// Group complete log events gate-wise and date-wise
interface GateCompleteLogSection {
  gate: {
    id: number;
    lcNumber: string;
    locationName: string;
    name: string | null;
    zone: string | null;
    division: string | null;
    scopeGroupName: string;
  };
  metrics: {
    totalOperations: number;
    totalDurationFormatted: string;
    avgDurationFormatted: string;
    extendedDelaysCount: number;
    currentlyOpenCount: number;
  };
  dateGroups: Array<{
    dateStr: string;
    dateFormatted: string;
    events: CompleteLogReportData['events'];
  }>;
}

function organizeCompleteLogData(data: CompleteLogReportData): GateCompleteLogSection[] {
  // 1. Group events by gateId
  const gateMap = new Map<number, {
    gateInfo: GateCompleteLogSection['gate'];
    events: CompleteLogReportData['events'];
  }>();

  for (const ev of data.events) {
    if (!gateMap.has(ev.gateId)) {
      const matchingGroup: any = null;

      gateMap.set(ev.gateId, {
        gateInfo: {
          id: ev.gate.id,
          lcNumber: ev.gate.lcNumber,
          locationName: ev.gate.locationName,
          name: ev.gate.name,
          zone: ev.gate.zone,
          division: ev.gate.division,
          scopeGroupName: matchingGroup?.name || 'Unassigned'
        },
        events: []
      });
    }
    gateMap.get(ev.gateId)!.events.push(ev);
  }

  // Also include target gates that had zero events so their metadata appears
  // (handled if needed, or by gateMap)

  const sections: GateCompleteLogSection[] = [];

  for (const [_, item] of gateMap.entries()) {
    // Partition events date-wise in IST
    const dateMap = new Map<string, CompleteLogReportData['events']>();

    let totalDurationSec = 0;
    let extendedDelays = 0;
    let currentlyOpen = 0;

    for (const ev of item.events) {
      if (ev.durationSeconds) totalDurationSec += ev.durationSeconds;
      if (ev.status === 'EXTENDED_DELAY') extendedDelays += 1;
      if (ev.status === 'OPEN') currentlyOpen += 1;

      const dStr = getISTDateString(new Date(ev.openedAt));
      if (!dateMap.has(dStr)) {
        dateMap.set(dStr, []);
      }
      dateMap.get(dStr)!.push(ev);
    }

    const totalOps = item.events.length;
    const avgDurationSec = totalOps > 0 ? Math.round(totalDurationSec / totalOps) : 0;

    const sortedDates = Array.from(dateMap.keys()).sort();
    const dateGroups = sortedDates.map(dStr => ({
      dateStr: dStr,
      dateFormatted: formatISTDateDisplay(dStr),
      events: dateMap.get(dStr)!
    }));

    sections.push({
      gate: item.gateInfo,
      metrics: {
        totalOperations: totalOps,
        totalDurationFormatted: formatDurationHuman(totalDurationSec),
        avgDurationFormatted: formatDurationHuman(avgDurationSec),
        extendedDelaysCount: extendedDelays,
        currentlyOpenCount: currentlyOpen
      },
      dateGroups
    });
  }

  // Sort sections by LC number
  sections.sort((a, b) => a.gate.lcNumber.localeCompare(b.gate.lcNumber));

  return sections;
}

/**
 * ─────────────────────────────────────────────────────────────
 * 1. EXPORT COMPLETE LOG REPORT: EXCEL (.xlsx)
 * ─────────────────────────────────────────────────────────────
 */
export async function exportCompleteLogExcel(
  res: Response,
  data: CompleteLogReportData,
  activeColumns: ActiveColumn[],
  options: { shiftFilter?: string; statusFilter?: string; filenameBase: string }
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Indian Railways - Level Crossing Safety Platform';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Operational Logs', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const totalCols = Math.max(8, activeColumns.length);
  const lastColLetter = String.fromCharCode(64 + totalCols);

  // Row 1: Government Header
  sheet.mergeCells(`A1:${lastColLetter}1`);
  const r1 = sheet.getCell('A1');
  r1.value = 'GOVERNMENT OF INDIA — MINISTRY OF RAILWAYS';
  r1.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r1.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;

  // Row 2: Title
  sheet.mergeCells(`A2:${lastColLetter}2`);
  const r2 = sheet.getCell('A2');
  r2.value = 'INDIAN RAILWAYS — LEVEL CROSSING OPERATIONAL LOG REPORT';
  r2.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r2.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 32;

  // Row 3: Subtitle
  sheet.mergeCells(`A3:${lastColLetter}3`);
  const r3 = sheet.getCell('A3');
  r3.value = `Complete Operational History & Audit Log (${data.startDateStr} to ${data.endDateStr})`;
  r3.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF003580' } };
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5A3' } };
  r3.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(3).height = 22;

  // Tricolor Ribbons
  sheet.mergeCells(`A4:${lastColLetter}4`);
  sheet.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } };
  sheet.getRow(4).height = 4;

  sheet.mergeCells(`A5:${lastColLetter}5`);
  sheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet.getRow(5).height = 3;

  sheet.mergeCells(`A6:${lastColLetter}6`);
  sheet.getCell('A6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF046A38' } };
  sheet.getRow(6).height = 4;

  // Global Metadata
  sheet.getRow(7).height = 8;
  sheet.getCell('A8').value = 'Date Range:';
  sheet.getCell('B8').value = `${data.startDateStr} to ${data.endDateStr}`;
  sheet.getCell('C8').value = 'Generated At:';
  sheet.getCell('D8').value = `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  sheet.getCell('E8').value = 'Shift Filter:';
  sheet.getCell('F8').value = options.shiftFilter || 'ALL SHIFTS';
  sheet.getCell('G8').value = 'Status Filter:';
  sheet.getCell('H8').value = options.statusFilter || 'ALL STATUSES';

  ['A8', 'C8', 'E8', 'G8'].forEach(cell => {
    sheet.getCell(cell).font = { bold: true, color: { argb: 'FF003580' } };
  });
  sheet.getRow(8).height = 20;

  // Global Summary
  sheet.getCell('A9').value = 'Total Operations:';
  sheet.getCell('B9').value = data.metrics.totalOperations;
  sheet.getCell('C9').value = 'Total Duration:';
  sheet.getCell('D9').value = data.metrics.totalDurationFormatted;
  sheet.getCell('E9').value = 'Average Duration:';
  sheet.getCell('F9').value = data.metrics.avgDurationFormatted;
  sheet.getCell('G9').value = 'Reporting Gates:';
  sheet.getCell('H9').value = data.metrics.reportingGatesCount;

  ['A9', 'C9', 'E9', 'G9'].forEach(cell => {
    sheet.getCell(cell).font = { bold: true, color: { argb: 'FF003580' } };
  });
  sheet.getRow(9).height = 20;
  sheet.getRow(10).height = 12;

  // Gate-wise sections
  const sections = organizeCompleteLogData(data);
  let curRow = 11;

  if (sections.length === 0) {
    sheet.mergeCells(`A${curRow}:${lastColLetter}${curRow}`);
    const emptyCell = sheet.getCell(`A${curRow}`);
    emptyCell.value = 'No operational records found for the selected gates and criteria.';
    emptyCell.font = { italic: true, color: { argb: 'FF64748B' } };
    emptyCell.alignment = { horizontal: 'center' };
    sheet.getRow(curRow).height = 30;
  }

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];

    // Gate Section Header Banner
    sheet.mergeCells(`A${curRow}:${lastColLetter}${curRow}`);
    const secHead = sheet.getCell(`A${curRow}`);
    secHead.value = `SECTION ${sIdx + 1}: LC GATE ${sec.gate.lcNumber} — ${sec.gate.locationName} (${sec.gate.scopeGroupName})`;
    secHead.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    secHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
    secHead.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    sheet.getRow(curRow).height = 26;
    curRow++;

    // Gate Metadata Sub-row
    sheet.getCell(`A${curRow}`).value = 'LC Number:';
    sheet.getCell(`B${curRow}`).value = sec.gate.lcNumber;
    sheet.getCell(`C${curRow}`).value = 'Location:';
    sheet.getCell(`D${curRow}`).value = sec.gate.locationName;
    sheet.getCell(`E${curRow}`).value = 'Zone:';
    sheet.getCell(`F${curRow}`).value = sec.gate.zone || '-';
    sheet.getCell(`G${curRow}`).value = 'Division:';
    sheet.getCell(`H${curRow}`).value = sec.gate.division || '-';
    ['A', 'C', 'E', 'G'].forEach(col => {
      sheet.getCell(`${col}${curRow}`).font = { bold: true, size: 9, color: { argb: 'FF475569' } };
    });
    sheet.getRow(curRow).height = 18;
    curRow++;

    // Gate Operational Summary
    sheet.getCell(`A${curRow}`).value = 'Gate Operations:';
    sheet.getCell(`B${curRow}`).value = sec.metrics.totalOperations;
    sheet.getCell(`C${curRow}`).value = 'Gate Total Duration:';
    sheet.getCell(`D${curRow}`).value = sec.metrics.totalDurationFormatted;
    sheet.getCell(`E${curRow}`).value = 'Gate Avg Duration:';
    sheet.getCell(`F${curRow}`).value = sec.metrics.avgDurationFormatted;
    sheet.getCell(`G${curRow}`).value = 'Extended Delays (>15m):';
    sheet.getCell(`H${curRow}`).value = sec.metrics.extendedDelaysCount;
    ['A', 'C', 'E', 'G'].forEach(col => {
      sheet.getCell(`${col}${curRow}`).font = { bold: true, size: 9, color: { argb: 'FF475569' } };
    });
    sheet.getRow(curRow).height = 18;
    curRow++;

    // Date-wise partitioned operational logs
    for (const dg of sec.dateGroups) {
      // Date Subheader
      sheet.mergeCells(`A${curRow}:${lastColLetter}${curRow}`);
      const dateHead = sheet.getCell(`A${curRow}`);
      dateHead.value = `📅  OPERATIONAL DATE: ${dg.dateFormatted}  (${dg.events.length} operations)`;
      dateHead.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: 'FF1E293B' } };
      dateHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      dateHead.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      sheet.getRow(curRow).height = 22;
      curRow++;

      // Table Header Row for this date
      const thRow = sheet.getRow(curRow);
      thRow.values = activeColumns.map(c => c.label);
      thRow.height = 22;
      thRow.eachCell((cell) => {
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { bottom: { style: 'medium', color: { argb: 'FF003580' } } };
      });
      curRow++;

      // Data Rows
      for (let eIdx = 0; eIdx < dg.events.length; eIdx++) {
        const ev = dg.events[eIdx];
        const rowMap = buildCompleteLogRowMap(ev, sec.gate);

        const rowValues = activeColumns.map(c => rowMap[c.key]);
        const dRow = sheet.getRow(curRow);
        dRow.values = rowValues;
        dRow.height = 20;

        const isEven = eIdx % 2 === 0;
        dRow.eachCell((cell, colNum) => {
          cell.font = { name: 'Calibri', size: 9.5 };
          cell.alignment = { vertical: 'middle', horizontal: colNum === 2 ? 'center' : 'left' };
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
          if (!isEven) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }

          const colKey = activeColumns[colNum - 1]?.key;
          if (colKey === 'status') {
            const val = String(cell.value).toUpperCase();
            if (val === 'CLOSED') {
              cell.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FF166534' } };
            } else if (val === 'EXTENDED_DELAY') {
              cell.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FFB45309' } };
            } else if (val === 'OPEN') {
              cell.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FFDC2626' } };
            }
          }
        });
        curRow++;
      }

      // Spacer after date group
      sheet.getRow(curRow).height = 6;
      curRow++;
    }

    // Spacer between gate sections
    sheet.getRow(curRow).height = 14;
    curRow++;
  }

  // Auto-fit column widths
  activeColumns.forEach((col, idx) => {
    sheet.getColumn(idx + 1).width = Math.max(16, col.label.length + 5);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.xlsx"`);
  res.setHeader('Content-Length', buffer.byteLength.toString());
  return res.status(200).send(Buffer.from(buffer));
}

/**
 * ─────────────────────────────────────────────────────────────
 * 2. EXPORT COMPLETE LOG REPORT: PDF (.pdf)
 * ─────────────────────────────────────────────────────────────
 */
export async function exportCompleteLogPdf(
  res: Response,
  data: CompleteLogReportData,
  activeColumns: ActiveColumn[],
  options: { shiftFilter?: string; statusFilter?: string; filenameBase: string }
) {
  const doc = new PDFDocument({
    bufferPages: true,
    layout: 'landscape',
    size: 'A4',
    margin: 36,
    info: {
      Title: `LC Gate Operations Report (${data.startDateStr} - ${data.endDateStr})`,
      Author: 'Indian Railways - Level Crossing Safety Platform',
    }
  });

  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    return res.status(200).send(pdfBuffer);
  });
  doc.on('error', pdfErr => {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'PDF Generation Error', message: pdfErr.message });
    }
  });

  const { irLogoPath, azadiLogoPath } = resolveLogos();

  // Draw Page Header Banner
  function drawPageBanner(docInstance: typeof doc, isFirstPage: boolean) {
    if (isFirstPage) {
      docInstance.rect(0, 0, docInstance.page.width, 90).fill(NAVY_BLUE);

      if (irLogoPath) {
        try { docInstance.image(irLogoPath, 16, 11, { fit: [72, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }
      if (azadiLogoPath) {
        try { docInstance.image(azadiLogoPath, docInstance.page.width - 100, 11, { fit: [84, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }

      docInstance.fillColor('white').fontSize(9.5).font('Helvetica')
        .text('Government of India', 0, 11, { align: 'center' })
        .text('Ministry of Railways', 0, 24, { align: 'center' });

      docInstance.fillColor('white').fontSize(18).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS', 0, 37, { align: 'center' });

      docInstance.fillColor(GOLDEN_SAND).fontSize(10.5).font('Helvetica')
        .text('Level Crossing Safety & Operational Audit Log Report', 0, 59, { align: 'center' });

      docInstance.rect(0, 75, docInstance.page.width, 5).fill(SAFFRON);
      docInstance.rect(0, 80, docInstance.page.width, 5).fill('white');
      docInstance.rect(0, 85, docInstance.page.width, 5).fill(DEEP_GREEN);
    } else {
      docInstance.rect(0, 0, docInstance.page.width, 24).fill(NAVY_BLUE);
      docInstance.fillColor('white').fontSize(9).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS — Level Crossing Operational Log (Continued)', 0, 7, { align: 'center' });
      docInstance.rect(0, 24, docInstance.page.width, 2).fill(SAFFRON);
    }
  }

  drawPageBanner(doc, true);

  // Global Metadata Box
  let yPos = 98;
  doc.rect(36, yPos, doc.page.width - 72, 38).strokeColor('#CCCCCC').lineWidth(1).stroke();
  const mY = yPos + 6;
  const col1X = 46;
  const col2X = doc.page.width * 0.38;
  const col3X = doc.page.width * 0.72;

  doc.fillColor('#334155').fontSize(8.5).font('Helvetica');
  doc.text(`Date Range: ${data.startDateStr}  —  ${data.endDateStr}`, col1X, mY);
  doc.text(`Generated At: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, col2X, mY);
  doc.text(`Shift Filter: ${options.shiftFilter || 'ALL SHIFTS'}`, col3X, mY);

  doc.text(`Scope Groups: ${data.targetScopeGroupIds?.length ? `${data.targetScopeGroupIds.length} Groups` : 'All Assigned'}`, col1X, mY + 15);
  doc.text(`Gates Filtered: ${data.metrics.reportingGatesCount} Reporting Gates`, col2X, mY + 15);
  doc.text(`Status Filter: ${options.statusFilter || 'ALL STATUSES'}`, col3X, mY + 15);

  yPos += 46;

  // Global KPI Badges
  const kpiWidth = (doc.page.width - 72 - 30) / 4;
  const kpis = [
    { label: 'TOTAL OPERATIONS', val: `${data.metrics.totalOperations}` },
    { label: 'TOTAL OPEN TIME', val: data.metrics.totalDurationFormatted },
    { label: 'AVERAGE CLEARANCE PACE', val: data.metrics.avgDurationFormatted },
    { label: 'EXTENDED DELAYS (>15m)', val: `${data.metrics.extendedDelaysCount}` },
  ];

  kpis.forEach((kpi, i) => {
    const xPos = 36 + i * (kpiWidth + 10);
    doc.rect(xPos, yPos, kpiWidth, 32).fillAndStroke('#F1F5F9', '#CBD5E1');
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(kpi.label, xPos + 8, yPos + 5);
    doc.fillColor(NAVY_BLUE).fontSize(11).font('Helvetica-Bold').text(kpi.val, xPos + 8, yPos + 16);
  });

  yPos += 42;

  const sections = organizeCompleteLogData(data);
  const pdfCols = activeColumns;
  const colWidth = (doc.page.width - 72) / pdfCols.length;

  if (sections.length === 0) {
    doc.rect(36, yPos, doc.page.width - 72, 30).fill('#F8FAFC');
    doc.fillColor('#64748B').fontSize(10).font('Helvetica-Oblique')
      .text('No operational events recorded for the selected scope groups, gates, and date range.', 36, yPos + 10, {
        align: 'center',
        width: doc.page.width - 72
      });
  }

  for (let sIdx = 0; sIdx < sections.length; sIdx++) {
    const sec = sections[sIdx];

    // Page overflow check for gate section header
    if (yPos > doc.page.height - 120) {
      doc.addPage({ layout: 'landscape', size: 'A4', margin: 36 });
      drawPageBanner(doc, false);
      yPos = 36;
    }

    // Gate Section Header
    doc.rect(36, yPos, doc.page.width - 72, 22).fill(NAVY_BLUE);
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
      .text(`SECTION ${sIdx + 1}: LC GATE ${sec.gate.lcNumber} — ${sec.gate.locationName} (${sec.gate.scopeGroupName})`, 44, yPos + 6);
    yPos += 26;

    // Gate Metadata Sub-line
    doc.rect(36, yPos, doc.page.width - 72, 18).fill('#F1F5F9');
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica')
      .text(`Zone: ${sec.gate.zone || '-'}  |  Division: ${sec.gate.division || '-'}  |  Gate Ops: ${sec.metrics.totalOperations}  |  Avg Duration: ${sec.metrics.avgDurationFormatted}  |  Delays: ${sec.metrics.extendedDelaysCount}`, 44, yPos + 5);
    yPos += 24;

    // Date Groups
    for (const dg of sec.dateGroups) {
      // Check space for date header and at least 2 table rows
      if (yPos > doc.page.height - 70) {
        doc.addPage({ layout: 'landscape', size: 'A4', margin: 36 });
        drawPageBanner(doc, false);
        yPos = 36;
      }

      // Date Header Banner
      doc.rect(36, yPos, doc.page.width - 72, 16).fill('#E2E8F0');
      doc.fillColor('#1E293B').fontSize(8.5).font('Helvetica-Bold')
        .text(`OPERATIONAL DATE: ${dg.dateFormatted}  (${dg.events.length} operations)`, 44, yPos + 4);
      yPos += 18;

      // Table Header
      doc.rect(36, yPos, doc.page.width - 72, 18).fill(HEADER_BG);
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
      pdfCols.forEach((col, i) => {
        doc.text(col.label, 36 + i * colWidth + 4, yPos + 5, { width: colWidth - 8, align: 'left', lineBreak: false });
      });
      yPos += 18;

      // Rows
      dg.events.forEach((ev, eIdx) => {
        if (yPos > doc.page.height - 60) {
          doc.addPage({ layout: 'landscape', size: 'A4', margin: 36 });
          drawPageBanner(doc, false);
          yPos = 36;

          // Redraw Table Header on new page
          doc.rect(36, yPos, doc.page.width - 72, 18).fill(HEADER_BG);
          doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
          pdfCols.forEach((col, i) => {
            doc.text(col.label, 36 + i * colWidth + 4, yPos + 5, { width: colWidth - 8, align: 'left', lineBreak: false });
          });
          yPos += 18;
        }

        const rowMap = buildCompleteLogRowMap(ev, sec.gate);

        const isEven = eIdx % 2 === 0;
        doc.rect(36, yPos, doc.page.width - 72, 16).fill(isEven ? '#FFFFFF' : ZEBRA_BG);

        pdfCols.forEach((col, i) => {
          const val = rowMap[col.key] || '-';
          if (col.key === 'status') {
            doc.fillColor(val === 'CLOSED' ? '#166534' : (val === 'EXTENDED_DELAY' ? '#B45309' : '#DC2626'));
          } else {
            doc.fillColor('#1E293B');
          }
          doc.fontSize(7.5).font('Helvetica')
            .text(val, 36 + i * colWidth + 4, yPos + 4, { width: colWidth - 8, align: 'left', lineBreak: false });
        });

        doc.moveTo(36, yPos + 16).lineTo(doc.page.width - 36, yPos + 16).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
        yPos += 16;
      });

      yPos += 6; // Space after date group
    }

    yPos += 12; // Space between gate sections
  }

  // Footer on all pages (prevent auto page overflow)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const prevMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica')
      .text(`Generated on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | Level Crossing Safety Platform | Page ${i - range.start + 1} of ${range.count}`, 36, doc.page.height - 20, {
        align: 'center',
        width: doc.page.width - 72,
        lineBreak: false
      });
    doc.page.margins.bottom = prevMargin;
  }

  doc.end();
}

/**
 * ─────────────────────────────────────────────────────────────
 * 3. EXPORT CYCLE REPORT: EXCEL (.xlsx)
 * ─────────────────────────────────────────────────────────────
 */
export async function exportCycleExcel(
  res: Response,
  cycleData: FullCycleAnalyticsResponse,
  options: { filenameBase: string }
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Indian Railways - Level Crossing Safety Platform';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Cycle Analytics Report', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const lastColLetter = 'F';

  // Row 1: Government Header
  sheet.mergeCells(`A1:${lastColLetter}1`);
  const r1 = sheet.getCell('A1');
  r1.value = 'GOVERNMENT OF INDIA — MINISTRY OF RAILWAYS';
  r1.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r1.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;

  // Row 2: Title
  sheet.mergeCells(`A2:${lastColLetter}2`);
  const r2 = sheet.getCell('A2');
  r2.value = 'INDIAN RAILWAYS — LEVEL CROSSING DURATION REPORT';
  r2.font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r2.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 32;

  // Row 3: Subtitle
  sheet.mergeCells(`A3:${lastColLetter}3`);
  const r3 = sheet.getCell('A3');
  r3.value = `Gate Utilization & Analytical Cycle Duration Audit (${cycleData.startDate} to ${cycleData.endDate})`;
  r3.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF003580' } };
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5A3' } };
  r3.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(3).height = 22;

  // Tricolor Ribbons
  sheet.mergeCells(`A4:${lastColLetter}4`);
  sheet.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } };
  sheet.getRow(4).height = 4;

  sheet.mergeCells(`A5:${lastColLetter}5`);
  sheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet.getRow(5).height = 3;

  sheet.mergeCells(`A6:${lastColLetter}6`);
  sheet.getCell('A6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF046A38' } };
  sheet.getRow(6).height = 4;

  // Global Metadata
  sheet.getRow(7).height = 8;
  sheet.getCell('A8').value = 'Reporting Period:';
  sheet.getCell('B8').value = `${cycleData.startDate} to ${cycleData.endDate}`;
  sheet.getCell('C8').value = 'Generated At:';
  sheet.getCell('D8').value = `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  sheet.getCell('E8').value = 'Reporting Gates:';
  sheet.getCell('F8').value = cycleData.overall.reportingGatesCount;

  ['A8', 'C8', 'E8'].forEach(cell => {
    sheet.getCell(cell).font = { bold: true, color: { argb: 'FF003580' } };
  });
  sheet.getRow(8).height = 20;

  // Overall KPI Summary
  sheet.getCell('A9').value = 'Total Completed Cycles:';
  sheet.getCell('B9').value = cycleData.overall.totalCycles;
  sheet.getCell('C9').value = 'Avg Closing Time:';
  sheet.getCell('D9').value = cycleData.overall.avgClosingFormatted;
  sheet.getCell('E9').value = 'Avg Opening Interval:';
  sheet.getCell('F9').value = cycleData.overall.avgOpeningFormatted;

  ['A9', 'C9', 'E9'].forEach(cell => {
    sheet.getCell(cell).font = { bold: true, color: { argb: 'FF003580' } };
  });
  sheet.getRow(9).height = 20;
  sheet.getRow(10).height = 12;

  let curRow = 11;

  for (let gIdx = 0; gIdx < cycleData.gateReports.length; gIdx++) {
    const gr = cycleData.gateReports[gIdx];

    // Gate Section Header
    sheet.mergeCells(`A${curRow}:${lastColLetter}${curRow}`);
    const secHead = sheet.getCell(`A${curRow}`);
    secHead.value = `SECTION ${gIdx + 1}: LC GATE ${gr.gate.lcNumber} — ${gr.gate.locationName} (${gr.gate.scopeGroupName})`;
    secHead.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    secHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
    secHead.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    sheet.getRow(curRow).height = 26;
    curRow++;

    // Gate Metadata Sub-row
    sheet.getCell(`A${curRow}`).value = 'LC Number:';
    sheet.getCell(`B${curRow}`).value = gr.gate.lcNumber;
    sheet.getCell(`C${curRow}`).value = 'Location:';
    sheet.getCell(`D${curRow}`).value = gr.gate.locationName;
    sheet.getCell(`E${curRow}`).value = 'Zone / Division:';
    sheet.getCell(`F${curRow}`).value = `${gr.gate.zone || '-'} / ${gr.gate.division || '-'}`;
    ['A', 'C', 'E'].forEach(col => {
      sheet.getCell(`${col}${curRow}`).font = { bold: true, size: 9, color: { argb: 'FF475569' } };
    });
    sheet.getRow(curRow).height = 18;
    curRow++;

    // Gate KPI Cards Row
    sheet.getCell(`A${curRow}`).value = 'Total Completed Cycles:';
    sheet.getCell(`B${curRow}`).value = gr.kpis.totalCycles;
    sheet.getCell(`C${curRow}`).value = 'Average Closing Time:';
    sheet.getCell(`D${curRow}`).value = gr.kpis.avgClosingFormatted;
    sheet.getCell(`E${curRow}`).value = 'Average Opening Interval:';
    sheet.getCell(`F${curRow}`).value = gr.kpis.avgOpeningFormatted;
    ['A', 'C', 'E'].forEach(col => {
      sheet.getCell(`${col}${curRow}`).font = { bold: true, size: 9, color: { argb: 'FF003580' } };
    });
    sheet.getRow(curRow).height = 20;
    curRow++;

    sheet.getCell(`A${curRow}`).value = 'Total Closed Duration:';
    sheet.getCell(`B${curRow}`).value = gr.kpis.totalClosedFormatted;
    sheet.getCell(`C${curRow}`).value = 'Total Open Duration:';
    sheet.getCell(`D${curRow}`).value = gr.kpis.totalOpenFormatted;
    sheet.getCell(`E${curRow}`).value = 'Reporting Window:';
    sheet.getCell(`F${curRow}`).value = `${cycleData.startDate} to ${cycleData.endDate}`;
    ['A', 'C', 'E'].forEach(col => {
      sheet.getCell(`${col}${curRow}`).font = { bold: true, size: 9, color: { argb: 'FF003580' } };
    });
    sheet.getRow(curRow).height = 20;
    curRow++;

    // Daily Cycle Summary Table Header
    const tableHeaders = [
      'Operational Date',
      'Completed Cycles',
      'Average Closing Time',
      'Average Opening Time',
      'Total Closed Duration',
      'Total Open Duration'
    ];
    const thRow = sheet.getRow(curRow);
    thRow.values = tableHeaders;
    thRow.height = 24;
    thRow.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF003580' } } };
    });
    curRow++;

    // Daily Breakdown Rows
    for (let dIdx = 0; dIdx < gr.dailyBreakdown.length; dIdx++) {
      const day = gr.dailyBreakdown[dIdx];
      const dRow = sheet.getRow(curRow);
      dRow.values = [
        day.dateFormatted,
        day.completedCycles,
        day.avgClosingFormatted,
        day.avgOpeningFormatted,
        day.totalClosedFormatted,
        day.totalOpenFormatted
      ];
      dRow.height = 20;

      const isEven = dIdx % 2 === 0;
      dRow.eachCell((cell, colNum) => {
        cell.font = { name: 'Calibri', size: 9.5 };
        cell.alignment = { vertical: 'middle', horizontal: colNum === 1 ? 'left' : 'center' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
        if (!isEven) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
        }
        if (colNum === 2 && day.completedCycles > 0) {
          cell.font = { name: 'Calibri', size: 9.5, bold: true, color: { argb: 'FF003580' } };
        }
      });
      curRow++;
    }

    sheet.getRow(curRow).height = 16;
    curRow++;
  }

  // Column Widths
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 24;
  sheet.getColumn(4).width = 24;
  sheet.getColumn(5).width = 22;
  sheet.getColumn(6).width = 22;

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.xlsx"`);
  res.setHeader('Content-Length', buffer.byteLength.toString());
  return res.status(200).send(Buffer.from(buffer));
}

/**
 * ─────────────────────────────────────────────────────────────
 * 4. EXPORT CYCLE REPORT: PDF (.pdf)
 * ─────────────────────────────────────────────────────────────
 */
export async function exportCyclePdf(
  res: Response,
  cycleData: FullCycleAnalyticsResponse,
  options: { filenameBase: string }
) {
  const doc = new PDFDocument({
    bufferPages: true,
    layout: 'landscape',
    size: 'A4',
    margin: 36,
    info: {
      Title: `LC Gate Cycle & Operational Summary Report (${cycleData.startDate} - ${cycleData.endDate})`,
      Author: 'Indian Railways - Level Crossing Safety Platform',
    }
  });

  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    return res.status(200).send(pdfBuffer);
  });
  doc.on('error', pdfErr => {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'PDF Generation Error', message: pdfErr.message });
    }
  });

  const { irLogoPath, azadiLogoPath } = resolveLogos();

  function drawCycleHeader(docInstance: typeof doc, isFirstPage: boolean) {
    if (isFirstPage) {
      docInstance.rect(0, 0, docInstance.page.width, 90).fill(NAVY_BLUE);

      if (irLogoPath) {
        try { docInstance.image(irLogoPath, 16, 11, { fit: [72, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }
      if (azadiLogoPath) {
        try { docInstance.image(azadiLogoPath, docInstance.page.width - 100, 11, { fit: [84, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }

      docInstance.fillColor('white').fontSize(9.5).font('Helvetica')
        .text('Government of India', 0, 11, { align: 'center' })
        .text('Ministry of Railways', 0, 24, { align: 'center' });

      docInstance.fillColor('white').fontSize(18).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS', 0, 37, { align: 'center' });

      docInstance.fillColor(GOLDEN_SAND).fontSize(10.5).font('Helvetica')
        .text('Level Crossing Duration Report', 0, 59, { align: 'center' });

      docInstance.rect(0, 75, docInstance.page.width, 5).fill(SAFFRON);
      docInstance.rect(0, 80, docInstance.page.width, 5).fill('white');
      docInstance.rect(0, 85, docInstance.page.width, 5).fill(DEEP_GREEN);
    } else {
      docInstance.rect(0, 0, docInstance.page.width, 24).fill(NAVY_BLUE);
      docInstance.fillColor('white').fontSize(9).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS — Level Crossing Duration Report (Continued)', 0, 7, { align: 'center' });
      docInstance.rect(0, 24, docInstance.page.width, 2).fill(SAFFRON);
    }
  }

  drawCycleHeader(doc, true);

  // Global Metadata Box
  let yPos = 98;
  doc.rect(36, yPos, doc.page.width - 72, 36).strokeColor('#CBD5E1').lineWidth(1).stroke();
  const isSingleGate = cycleData.gateReports.length === 1;
  const singleG = isSingleGate ? cycleData.gateReports[0].gate : null;

  doc.fillColor('#1E293B').fontSize(8.5).font('Helvetica-Bold');
  if (isSingleGate && singleG) {
    doc.text(`Assigned Gate: LC-${singleG.lcNumber} — ${singleG.locationName || singleG.name || 'Station Gate'}`, 46, yPos + 6);
    doc.fillColor('#64748B').fontSize(8).font('Helvetica')
      .text(`Zone / Division: ${singleG.zone || '-'} / ${singleG.division || '-'}`, doc.page.width * 0.65, yPos + 6);
  } else {
    doc.text(`Monitored Network: ${cycleData.overall.reportingGatesCount} Level Crossing Gates`, 46, yPos + 6);
    doc.fillColor('#64748B').fontSize(8).font('Helvetica')
      .text(`Total Cycle Volume: ${cycleData.overall.totalCycles} Completed Cycles`, doc.page.width * 0.65, yPos + 6);
  }

  doc.fillColor('#475569').fontSize(8).font('Helvetica')
    .text(`Audit Period: ${cycleData.startDate} to ${cycleData.endDate}`, 46, yPos + 20);
  doc.text(`Generated At: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, doc.page.width * 0.65, yPos + 20);

  yPos += 42;

  // Overall KPI Cards
  const kpiWidth = (doc.page.width - 72 - 30) / 4;
  const overallKpis = [
    { label: 'TOTAL COMPLETED CYCLES', val: `${cycleData.overall.totalCycles}` },
    { label: 'AVG CLOSING TIME', val: cycleData.overall.avgClosingFormatted },
    { label: 'AVG OPENING INTERVAL', val: cycleData.overall.avgOpeningFormatted },
    { label: 'TOTAL CLOSED DURATION', val: cycleData.overall.totalClosedFormatted },
  ];

  overallKpis.forEach((kpi, i) => {
    const xPos = 36 + i * (kpiWidth + 10);
    doc.rect(xPos, yPos, kpiWidth, 32).fillAndStroke('#F1F5F9', '#CBD5E1');
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(kpi.label, xPos + 8, yPos + 5);
    doc.fillColor(NAVY_BLUE).fontSize(11).font('Helvetica-Bold').text(kpi.val, xPos + 8, yPos + 16);
  });

  yPos += 42;

  // Per-gate sections
  for (let gIdx = 0; gIdx < cycleData.gateReports.length; gIdx++) {
    const gr = cycleData.gateReports[gIdx];

    // Check space for section header + KPI card + table header + at least 3 rows
    if (yPos > doc.page.height - 150) {
      doc.addPage({ layout: 'landscape', size: 'A4', margin: 36 });
      drawCycleHeader(doc, false);
      yPos = 36;
    }

    // Gate Section Header Banner
    doc.rect(36, yPos, doc.page.width - 72, 22).fill(NAVY_BLUE);
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold')
      .text(`SECTION ${gIdx + 1}: LC GATE ${gr.gate.lcNumber} — ${gr.gate.locationName} (${gr.gate.zone || '-'} / ${gr.gate.division || '-'})`, 44, yPos + 6);
    yPos += 26;

    // Structured Section 4-KPI Cards (Matching Top Header Style)
    const secKpiWidth = (doc.page.width - 72 - 30) / 4;
    const secKpis = [
      { label: 'COMPLETED CYCLES', val: `${gr.kpis.totalCycles}` },
      { label: 'AVG CLOSING TIME', val: gr.kpis.avgClosingFormatted || '—' },
      { label: 'AVG OPENING INTERVAL', val: gr.kpis.avgOpeningFormatted || '—' },
      { label: 'TOTAL CLOSED DURATION', val: gr.kpis.totalClosedFormatted || '0s' },
    ];
    secKpis.forEach((kpi, i) => {
      const xPos = 36 + i * (secKpiWidth + 10);
      doc.rect(xPos, yPos, secKpiWidth, 30).fillAndStroke('#F8FAFC', '#CBD5E1');
      doc.fillColor('#475569').fontSize(7).font('Helvetica-Bold').text(kpi.label, xPos + 8, yPos + 5);
      doc.fillColor(NAVY_BLUE).fontSize(10.5).font('Helvetica-Bold').text(kpi.val, xPos + 8, yPos + 15);
    });
    yPos += 36;

    // Table Header
    const cols = [
      { label: 'Operational Date', width: (doc.page.width - 72) * 0.22, align: 'left' as const },
      { label: 'Completed Cycles', width: (doc.page.width - 72) * 0.14, align: 'center' as const },
      { label: 'Avg Closing Time', width: (doc.page.width - 72) * 0.16, align: 'center' as const },
      { label: 'Avg Opening Time', width: (doc.page.width - 72) * 0.16, align: 'center' as const },
      { label: 'Total Closed Duration', width: (doc.page.width - 72) * 0.16, align: 'center' as const },
      { label: 'Total Open Duration', width: (doc.page.width - 72) * 0.16, align: 'center' as const },
    ];

    doc.rect(36, yPos, doc.page.width - 72, 18).fill(HEADER_BG);
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
    let xOffset = 36;
    cols.forEach(col => {
      doc.text(col.label, xOffset + 4, yPos + 5, { width: col.width - 8, align: col.align, lineBreak: false });
      xOffset += col.width;
    });
    yPos += 18;

    // Daily breakdown rows
    gr.dailyBreakdown.forEach((day, dIdx) => {
      if (yPos > doc.page.height - 60) {
        doc.addPage({ layout: 'landscape', size: 'A4', margin: 36 });
        drawCycleHeader(doc, false);
        yPos = 36;

        // Redraw Table Header on new page
        doc.rect(36, yPos, doc.page.width - 72, 18).fill(HEADER_BG);
        doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
        let xOff = 36;
        cols.forEach(col => {
          doc.text(col.label, xOff + 4, yPos + 5, { width: col.width - 8, align: col.align, lineBreak: false });
          xOff += col.width;
        });
        yPos += 18;
      }

      const isEven = dIdx % 2 === 0;
      doc.rect(36, yPos, doc.page.width - 72, 16).fill(isEven ? '#FFFFFF' : ZEBRA_BG);

      const rowValues = [
        day.dateFormatted,
        String(day.completedCycles),
        day.avgClosingFormatted,
        day.avgOpeningFormatted,
        day.totalClosedFormatted,
        day.totalOpenFormatted
      ];

      let rX = 36;
      cols.forEach((col, idx) => {
        doc.fillColor(idx === 1 && day.completedCycles > 0 ? NAVY_BLUE : '#1E293B');
        doc.fontSize(7.5).font(idx === 1 && day.completedCycles > 0 ? 'Helvetica-Bold' : 'Helvetica')
          .text(rowValues[idx], rX + 4, yPos + 4, { width: col.width - 8, align: col.align, lineBreak: false });
        rX += col.width;
      });

      doc.moveTo(36, yPos + 16).lineTo(doc.page.width - 36, yPos + 16).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
      yPos += 16;
    });

    yPos += 16; // Space after gate section
  }

  // Footer on all pages (prevent auto page overflow)
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const prevMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica')
      .text(`Generated on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | Level Crossing Safety Platform | Page ${i - range.start + 1} of ${range.count}`, 36, doc.page.height - 20, {
        align: 'center',
        width: doc.page.width - 72,
        lineBreak: false
      });
    doc.page.margins.bottom = prevMargin;
  }

  doc.end();
}

/**
 * ─────────────────────────────────────────────────────────────
 * 5. EXPORT COMPLETE LOG REPORT: CSV
 * ─────────────────────────────────────────────────────────────
 */
export function exportCompleteLogCsv(
  res: Response,
  data: CompleteLogReportData,
  activeColumns: ActiveColumn[],
  options: { filenameBase: string }
) {
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const sections = organizeCompleteLogData(data);
  const rows: string[] = [];

  // Header
  rows.push(activeColumns.map(c => escapeCsv(c.label)).join(','));

  for (const sec of sections) {
    for (const dg of sec.dateGroups) {
      for (const ev of dg.events) {
        const rowMap = buildCompleteLogRowMap(ev, sec.gate);

        rows.push(activeColumns.map(c => escapeCsv(rowMap[c.key])).join(','));
      }
    }
  }

  const csvContent = rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.csv"`);
  res.status(200).send(csvContent);
}

/**
 * ─────────────────────────────────────────────────────────────
 * 6. EXPORT CYCLE REPORT: CSV
 * ─────────────────────────────────────────────────────────────
 */
export function exportCycleCsv(
  res: Response,
  cycleData: FullCycleAnalyticsResponse,
  options: { filenameBase: string }
) {
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headers = [
    'LC Number',
    'Gate Name',
    'Location',
    'Zone',
    'Division',
    'Scope Group',
    'Operational Date',
    'Completed Cycles',
    'Average Closing Time',
    'Average Opening Time',
    'Total Closed Duration',
    'Total Open Duration'
  ];

  const rows: string[] = [];
  rows.push(headers.map(escapeCsv).join(','));

  for (const gr of cycleData.gateReports) {
    for (const day of gr.dailyBreakdown) {
      const row = [
        gr.gate.lcNumber,
        gr.gate.name || '-',
        gr.gate.locationName,
        gr.gate.zone || '-',
        gr.gate.division || '-',
        gr.gate.scopeGroupName || 'Unassigned',
        day.dateFormatted,
        day.completedCycles,
        day.avgClosingFormatted,
        day.avgOpeningFormatted,
        day.totalClosedFormatted,
        day.totalOpenFormatted
      ];
      rows.push(row.map(escapeCsv).join(','));
    }
  }

  const csvContent = rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.csv"`);
  res.status(200).send(csvContent);
}



// ============================================================================
// COUNT REPORT EXPORTERS (CSV, EXCEL, PDF)
// ============================================================================

export function exportCountCsv(
  res: Response,
  data: CountReportResponse,
  options: { filenameBase: string }
) {
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headers = [
    'Zone',
    'Division',
    'Station',
    'Station Code',
    'LC Number',
    'Gate Name / Location',
    'Open Count',
    'Close Count',
    'Total Operations'
  ];

  const rows: string[] = [];
  rows.push(headers.map(escapeCsv).join(','));

  for (const g of data.gates) {
    const row = [
      g.zone || '-',
      g.division || '-',
      g.stationName || '-',
      g.stationCode || '-',
      g.lcNumber,
      g.locationName,
      g.openCount,
      g.closeCount,
      g.totalOperations
    ];
    rows.push(row.map(escapeCsv).join(','));
  }

  const csvContent = rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.csv"`);
  res.status(200).send(csvContent);
}

export async function exportCountExcel(
  res: Response,
  data: CountReportResponse,
  options: { filenameBase: string }
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Indian Railways - Level Crossing Platform';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Count Report', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const lastColLetter = 'I';

  // Row 1: Header
  sheet.mergeCells(`A1:${lastColLetter}1`);
  const r1 = sheet.getCell('A1');
  r1.value = 'GOVERNMENT OF INDIA — MINISTRY OF RAILWAYS';
  r1.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r1.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;

  // Row 2: Title
  sheet.mergeCells(`A2:${lastColLetter}2`);
  const r2 = sheet.getCell('A2');
  r2.value = 'INDIAN RAILWAYS — LEVEL CROSSING OPERATIONS COUNT REPORT';
  r2.font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r2.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 32;

  // Row 3: Subtitle
  sheet.mergeCells(`A3:${lastColLetter}3`);
  const r3 = sheet.getCell('A3');
  r3.value = `Gate Barrier Operations Volume Audit (${data.startDate} to ${data.endDate})`;
  r3.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF003580' } };
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5A3' } };
  r3.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(3).height = 22;

  // Tricolor Ribbons (Rows 4, 5, 6)
  sheet.mergeCells(`A4:${lastColLetter}4`);
  sheet.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } };
  sheet.getRow(4).height = 4;

  sheet.mergeCells(`A5:${lastColLetter}5`);
  sheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet.getRow(5).height = 3;

  sheet.mergeCells(`A6:${lastColLetter}6`);
  sheet.getCell('A6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF046A38' } };
  sheet.getRow(6).height = 4;

  // Metadata (Row 8)
  sheet.getRow(7).height = 6;
  sheet.getCell('A8').value = 'Date Range:';
  sheet.getCell('B8').value = `${data.startDate} to ${data.endDate}`;
  sheet.getCell('C8').value = 'Generated At:';
  sheet.getCell('D8').value = `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  sheet.getCell('E8').value = 'Reporting Gates:';
  sheet.getCell('F8').value = `${data.gates.length} Gates`;
  sheet.getCell('G8').value = 'Total Operations:';
  sheet.getCell('H8').value = data.kpis.totalOperations;

  ['A8', 'C8', 'E8', 'G8'].forEach(cell => {
    sheet.getCell(cell).font = { bold: true, color: { argb: 'FF003580' } };
  });
  sheet.getRow(8).height = 20;

  // Row 10-11: KPI Cards
  sheet.getCell('A10').value = 'Total Operations';
  sheet.getCell('A11').value = data.kpis.totalOperations;
  sheet.getCell('C10').value = 'Total Open Count';
  sheet.getCell('C11').value = data.kpis.totalOpenCount;
  sheet.getCell('E10').value = 'Total Close Count';
  sheet.getCell('E11').value = data.kpis.totalCloseCount;
  sheet.getCell('G10').value = 'Peak Activity Gate';
  sheet.getCell('G11').value = data.kpis.peakOperationGate ? `${data.kpis.peakOperationGate.lcNumber} (${data.kpis.peakOperationGate.operations})` : '—';

  for (const col of ['A', 'C', 'E', 'G']) {
    sheet.getCell(`${col}10`).font = { bold: true, size: 9, color: { argb: 'FF64748B' } };
    sheet.getCell(`${col}11`).font = { bold: true, size: 14, color: { argb: 'FF003580' } };
  }
  sheet.getRow(10).height = 16;
  sheet.getRow(11).height = 22;

  // Row 13: Table Header
  const headers = ['Zone', 'Division', 'Station', 'Code', 'LC Gate #', 'Location / Landmark', 'Open Count', 'Close Count', 'Total Operations'];
  sheet.getRow(13).values = headers;
  sheet.getRow(13).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C7A' } };
  sheet.getRow(13).height = 26;

  let rowIdx = 14;
  for (const g of data.gates) {
    const row = sheet.getRow(rowIdx);
    row.values = [
      g.zone,
      g.division,
      g.stationName,
      g.stationCode,
      g.lcNumber,
      g.locationName,
      g.openCount,
      g.closeCount,
      g.totalOperations
    ];
    if (rowIdx % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    }
    rowIdx++;
  }

  // Auto-fit column widths
  sheet.columns = [
    { width: 18 }, { width: 16 }, { width: 18 }, { width: 10 },
    { width: 14 }, { width: 24 }, { width: 14 }, { width: 14 }, { width: 18 }
  ];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

export async function exportCountPdf(
  res: Response,
  data: CountReportResponse,
  options: { filenameBase: string }
) {
  const doc = new PDFDocument({ bufferPages: true, margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.pdf"`);
  doc.pipe(res);

  const { irLogoPath, azadiLogoPath } = resolveLogos();

  function drawCountHeader(docInstance: typeof doc, isFirstPage: boolean) {
    if (isFirstPage) {
      docInstance.rect(0, 0, docInstance.page.width, 90).fill(NAVY_BLUE);

      if (irLogoPath) {
        try { docInstance.image(irLogoPath, 16, 11, { fit: [72, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }
      if (azadiLogoPath) {
        try { docInstance.image(azadiLogoPath, docInstance.page.width - 100, 11, { fit: [84, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }

      docInstance.fillColor('white').fontSize(9.5).font('Helvetica')
        .text('Government of India', 0, 11, { align: 'center' })
        .text('Ministry of Railways', 0, 24, { align: 'center' });

      docInstance.fillColor('white').fontSize(18).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS', 0, 37, { align: 'center' });

      docInstance.fillColor(GOLDEN_SAND).fontSize(10.5).font('Helvetica')
        .text('Level Crossing Operations Volume & Count Audit Report', 0, 59, { align: 'center' });

      docInstance.rect(0, 75, docInstance.page.width, 5).fill(SAFFRON);
      docInstance.rect(0, 80, docInstance.page.width, 5).fill('white');
      docInstance.rect(0, 85, docInstance.page.width, 5).fill(DEEP_GREEN);
    } else {
      docInstance.rect(0, 0, docInstance.page.width, 24).fill(NAVY_BLUE);
      docInstance.fillColor('white').fontSize(9).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS — Level Crossing Count Report (Continued)', 0, 7, { align: 'center' });
      docInstance.rect(0, 24, docInstance.page.width, 2).fill(SAFFRON);
    }
  }

  drawCountHeader(doc, true);

  // Global Metadata Box
  let yPos = 98;
  doc.rect(36, yPos, doc.page.width - 72, 34).strokeColor('#CCCCCC').lineWidth(1).stroke();
  const mY = yPos + 6;
  doc.fillColor('#334155').fontSize(8.5).font('Helvetica');
  doc.text(`Audit Period: ${data.startDate}  —  ${data.endDate}`, 46, mY);
  doc.text(`Generated At: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, doc.page.width * 0.38, mY);
  doc.text(`Reporting Gates: ${data.gates.length} LC Gates`, doc.page.width * 0.72, mY);

  yPos += 42;

  // KPI Summary Cards
  const kpiWidth = (doc.page.width - 72 - 30) / 4;
  const countKpis = [
    { label: 'TOTAL OPERATIONS', val: `${data.kpis.totalOperations}` },
    { label: 'BARRIER OPENINGS', val: `${data.kpis.totalOpenCount}` },
    { label: 'BARRIER CLOSINGS', val: `${data.kpis.totalCloseCount}` },
    { label: 'PEAK ACTIVITY GATE', val: data.kpis.peakOperationGate ? `${data.kpis.peakOperationGate.lcNumber} (${data.kpis.peakOperationGate.operations})` : '—' },
  ];

  countKpis.forEach((kpi, i) => {
    const xPos = 36 + i * (kpiWidth + 10);
    doc.rect(xPos, yPos, kpiWidth, 32).fillAndStroke('#F1F5F9', '#CBD5E1');
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(kpi.label, xPos + 8, yPos + 5);
    doc.fillColor(NAVY_BLUE).fontSize(10.5).font('Helvetica-Bold').text(kpi.val, xPos + 8, yPos + 16);
  });

  yPos += 42;

  // Table Header
  const tableX = 36;
  const tableWidth = doc.page.width - 72;
  doc.rect(tableX, yPos, tableWidth, 20).fill('#0B3C7A');
  doc.fillColor('#FFFFFF').fontSize(8.5).font('Helvetica-Bold');
  doc.text('Zone', tableX + 6, yPos + 5, { width: 75 });
  doc.text('Division', tableX + 85, yPos + 5, { width: 75 });
  doc.text('Station', tableX + 165, yPos + 5, { width: 95 });
  doc.text('LC Gate #', tableX + 265, yPos + 5, { width: 75 });
  doc.text('Location / Landmark', tableX + 345, yPos + 5, { width: 190 });
  doc.text('Open Count', tableX + 540, yPos + 5, { width: 65, align: 'right' });
  doc.text('Close Count', tableX + 610, yPos + 5, { width: 65, align: 'right' });
  doc.text('Total Operations', tableX + 680, yPos + 5, { width: 85, align: 'right' });

  yPos += 20;
  doc.font('Helvetica').fontSize(8.5);

  for (const g of data.gates) {
    if (yPos > doc.page.height - 60) {
      doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
      drawCountHeader(doc, false);
      yPos = 36;
      doc.rect(tableX, yPos, tableWidth, 18).fill('#0B3C7A');
      doc.fillColor('#FFFFFF').fontSize(8.5).font('Helvetica-Bold');
      doc.text('Zone', tableX + 6, yPos + 4, { width: 75 });
      doc.text('Division', tableX + 85, yPos + 4, { width: 75 });
      doc.text('Station', tableX + 165, yPos + 4, { width: 95 });
      doc.text('LC Gate #', tableX + 265, yPos + 4, { width: 75 });
      doc.text('Location / Landmark', tableX + 345, yPos + 4, { width: 190 });
      doc.text('Open Count', tableX + 540, yPos + 4, { width: 65, align: 'right' });
      doc.text('Close Count', tableX + 610, yPos + 4, { width: 65, align: 'right' });
      doc.text('Total Operations', tableX + 680, yPos + 4, { width: 85, align: 'right' });
      yPos += 18;
      doc.font('Helvetica').fontSize(8.5);
    }

    doc.fillColor('#0F172A');
    doc.text(g.zone || '-', tableX + 6, yPos + 4, { width: 75 });
    doc.text(g.division || '-', tableX + 85, yPos + 4, { width: 75 });
    doc.text(g.stationName || '-', tableX + 165, yPos + 4, { width: 95 });
    doc.text(g.lcNumber, tableX + 265, yPos + 4, { width: 75 });
    doc.text(g.locationName, tableX + 345, yPos + 4, { width: 190 });
    doc.text(String(g.openCount), tableX + 540, yPos + 4, { width: 65, align: 'right' });
    doc.text(String(g.closeCount), tableX + 610, yPos + 4, { width: 65, align: 'right' });
    doc.text(String(g.totalOperations), tableX + 680, yPos + 4, { width: 85, align: 'right' });

    doc.strokeColor('#E2E8F0').lineWidth(0.5).moveTo(tableX, yPos + 17).lineTo(tableX + tableWidth, yPos + 17).stroke();
    yPos += 18;
  }

  doc.end();
}

// ============================================================================
// HOLISTIC REPORT EXPORTERS (CSV, EXCEL, PDF)
// ============================================================================

export function exportHolisticCsv(
  res: Response,
  data: HolisticReportResponse,
  options: { filenameBase: string }
) {
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headers = [
    'Zone',
    'Division',
    'Station',
    'LC Gate Number',
    'Location Name',
    'Total Operations',
    'Open Count',
    'Close Count',
    'Total Open Duration',
    'Average Open Duration',
    'Total Closed Duration',
    'Extended Delays (>15m)'
  ];

  const rows: string[] = [];
  rows.push(headers.map(escapeCsv).join(','));

  for (const g of data.flatGates) {
    const row = [
      g.zone || '-',
      g.division || '-',
      g.stationName || '-',
      g.lcNumber,
      g.locationName,
      g.totalOperations,
      g.openCount,
      g.closeCount,
      g.totalOpenFormatted,
      g.avgOpenFormatted,
      g.totalClosedFormatted,
      g.extendedDelaysCount
    ];
    rows.push(row.map(escapeCsv).join(','));
  }

  const csvContent = rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.csv"`);
  res.status(200).send(csvContent);
}

export async function exportHolisticExcel(
  res: Response,
  data: HolisticReportResponse,
  options: { filenameBase: string }
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Indian Railways - Level Crossing Platform';
  workbook.created = new Date();

  // Sheet 1: Hierarchy Management Summary (Zone -> Division -> Station)
  const sheet1 = workbook.addWorksheet('Management Hierarchy', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const lastColLetter = 'I';

  // Row 1: Government Header
  sheet1.mergeCells(`A1:${lastColLetter}1`);
  const r1 = sheet1.getCell('A1');
  r1.value = 'GOVERNMENT OF INDIA — MINISTRY OF RAILWAYS';
  r1.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r1.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet1.getRow(1).height = 24;

  // Row 2: Title
  sheet1.mergeCells(`A2:${lastColLetter}2`);
  const r2 = sheet1.getCell('A2');
  r2.value = 'INDIAN RAILWAYS — HOLISTIC LEVEL CROSSING MANAGEMENT SUMMARY';
  r2.font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r2.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet1.getRow(2).height = 32;

  // Row 3: Subtitle
  sheet1.mergeCells(`A3:${lastColLetter}3`);
  const r3 = sheet1.getCell('A3');
  r3.value = `Hierarchical Operational Performance Audit (${data.startDate} to ${data.endDate})`;
  r3.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF003580' } };
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5A3' } };
  r3.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet1.getRow(3).height = 22;

  // Tricolor Ribbons (Rows 4, 5, 6)
  sheet1.mergeCells(`A4:${lastColLetter}4`);
  sheet1.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } };
  sheet1.getRow(4).height = 4;

  sheet1.mergeCells(`A5:${lastColLetter}5`);
  sheet1.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet1.getRow(5).height = 3;

  sheet1.mergeCells(`A6:${lastColLetter}6`);
  sheet1.getCell('A6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF046A38' } };
  sheet1.getRow(6).height = 4;

  // Metadata Row 8
  sheet1.getRow(7).height = 6;
  sheet1.getCell('A8').value = 'Date Range:';
  sheet1.getCell('B8').value = `${data.startDate} to ${data.endDate}`;
  sheet1.getCell('C8').value = 'Generated At:';
  sheet1.getCell('D8').value = `${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  sheet1.getCell('E8').value = 'Total Gates:';
  sheet1.getCell('F8').value = `${data.kpis.totalGates} Gates`;
  sheet1.getCell('G8').value = 'Total Operations:';
  sheet1.getCell('H8').value = data.kpis.totalOperations;

  ['A8', 'C8', 'E8', 'G8'].forEach(cell => {
    sheet1.getCell(cell).font = { bold: true, color: { argb: 'FF003580' } };
  });
  sheet1.getRow(8).height = 20;

  // KPI Row 10-11
  sheet1.getCell('A10').value = 'Total Operations';
  sheet1.getCell('A11').value = data.kpis.totalOperations;
  sheet1.getCell('C10').value = 'Total Open Time';
  sheet1.getCell('C11').value = data.kpis.totalOpenFormatted;
  sheet1.getCell('E10').value = 'Average Open Duration';
  sheet1.getCell('E11').value = data.kpis.avgOpenFormatted;
  sheet1.getCell('G10').value = 'Extended Delays (>15m)';
  sheet1.getCell('G11').value = data.kpis.totalExtendedDelays;

  for (const col of ['A', 'C', 'E', 'G']) {
    sheet1.getCell(`${col}10`).font = { bold: true, size: 9, color: { argb: 'FF64748B' } };
    sheet1.getCell(`${col}11`).font = { bold: true, size: 14, color: { argb: 'FF003580' } };
  }
  sheet1.getRow(10).height = 16;
  sheet1.getRow(11).height = 22;

  sheet1.getRow(13).values = ['Jurisdiction Level', 'Name', 'Total Gates', 'Operations', 'Open Count', 'Close Count', 'Total Open Time', 'Avg Open Time', 'Delays (>15m)'];
  sheet1.getRow(13).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet1.getRow(13).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C7A' } };
  sheet1.getRow(13).height = 24;

  let rIdx = 14;
  for (const zn of data.hierarchy) {
    const zRow = sheet1.getRow(rIdx++);
    zRow.values = ['ZONE', zn.zone, zn.gatesCount, zn.totalOperations, zn.openCount, zn.closeCount, zn.totalOpenFormatted, zn.avgOpenFormatted, zn.extendedDelaysCount];
    zRow.font = { bold: true };
    zRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } };

    for (const div of zn.divisions) {
      const dRow = sheet1.getRow(rIdx++);
      dRow.values = ['  DIVISION', `  ${div.division}`, div.gatesCount, div.totalOperations, div.openCount, div.closeCount, div.totalOpenFormatted, div.avgOpenFormatted, div.extendedDelaysCount];
      dRow.font = { bold: true };
      dRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

      for (const st of div.stations) {
        const sRow = sheet1.getRow(rIdx++);
        sRow.values = ['    STATION', `    ${st.stationName} (${st.stationCode})`, st.gatesCount, st.totalOperations, st.openCount, st.closeCount, st.totalOpenFormatted, st.avgOpenFormatted, st.extendedDelaysCount];
        for (const g of st.gates) {
          const gRow = sheet1.getRow(rIdx++);
          gRow.values = ['      LC GATE', `      ${g.lcNumber} - ${g.locationName}`, 1, g.totalOperations, g.openCount, g.closeCount, g.totalOpenFormatted, g.avgOpenFormatted, g.extendedDelaysCount];
        }
      }
    }
  }

  sheet1.columns = [
    { width: 16 }, { width: 28 }, { width: 12 }, { width: 14 },
    { width: 12 }, { width: 12 }, { width: 18 }, { width: 16 }, { width: 14 }
  ];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

export async function exportHolisticPdf(
  res: Response,
  data: HolisticReportResponse,
  options: { filenameBase: string }
) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.pdf"`);
  doc.pipe(res);

  const { irLogoPath, azadiLogoPath } = resolveLogos();

  function drawHolisticHeader(docInstance: typeof doc, isFirstPage: boolean) {
    if (isFirstPage) {
      docInstance.rect(0, 0, docInstance.page.width, 90).fill(NAVY_BLUE);

      if (irLogoPath) {
        try { docInstance.image(irLogoPath, 16, 11, { fit: [72, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }
      if (azadiLogoPath) {
        try { docInstance.image(azadiLogoPath, docInstance.page.width - 100, 11, { fit: [84, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }

      docInstance.fillColor('white').fontSize(9.5).font('Helvetica')
        .text('Government of India', 0, 11, { align: 'center' })
        .text('Ministry of Railways', 0, 24, { align: 'center' });

      docInstance.fillColor('white').fontSize(18).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS', 0, 37, { align: 'center' });

      docInstance.fillColor(GOLDEN_SAND).fontSize(10.5).font('Helvetica')
        .text('Level Crossing Holistic Management & Hierarchy Summary Report', 0, 59, { align: 'center' });

      docInstance.rect(0, 75, docInstance.page.width, 5).fill(SAFFRON);
      docInstance.rect(0, 80, docInstance.page.width, 5).fill('white');
      docInstance.rect(0, 85, docInstance.page.width, 5).fill(DEEP_GREEN);
    } else {
      docInstance.rect(0, 0, docInstance.page.width, 24).fill(NAVY_BLUE);
      docInstance.fillColor('white').fontSize(9).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS — Holistic Management Report (Continued)', 0, 7, { align: 'center' });
      docInstance.rect(0, 24, docInstance.page.width, 2).fill(SAFFRON);
    }
  }

  drawHolisticHeader(doc, true);

  // Global Metadata Box
  let yPos = 98;
  doc.rect(36, yPos, doc.page.width - 72, 34).strokeColor('#CCCCCC').lineWidth(1).stroke();
  const mY = yPos + 6;
  doc.fillColor('#334155').fontSize(8.5).font('Helvetica');
  doc.text(`Audit Period: ${data.startDate}  —  ${data.endDate}`, 46, mY);
  doc.text(`Generated At: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, doc.page.width * 0.38, mY);
  doc.text(`Total Gates Monitored: ${data.kpis.totalGates} Gates`, doc.page.width * 0.72, mY);

  yPos += 42;

  // KPI Summary Cards
  const kpiWidth = (doc.page.width - 72 - 30) / 4;
  const holisticKpis = [
    { label: 'TOTAL OPERATIONS', val: `${data.kpis.totalOperations}` },
    { label: 'TOTAL OPEN TIME', val: data.kpis.totalOpenFormatted },
    { label: 'AVERAGE OPEN DURATION', val: data.kpis.avgOpenFormatted },
    { label: 'EXTENDED DELAYS (>15m)', val: `${data.kpis.totalExtendedDelays}` },
  ];

  holisticKpis.forEach((kpi, i) => {
    const xPos = 36 + i * (kpiWidth + 10);
    doc.rect(xPos, yPos, kpiWidth, 32).fillAndStroke('#F1F5F9', '#CBD5E1');
    doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(kpi.label, xPos + 8, yPos + 5);
    doc.fillColor(NAVY_BLUE).fontSize(10.5).font('Helvetica-Bold').text(kpi.val, xPos + 8, yPos + 16);
  });

  yPos += 42;

  const tableX = 36;
  const tableWidth = doc.page.width - 72;
  doc.rect(tableX, yPos, tableWidth, 20).fill('#0B3C7A');
  doc.fillColor('#FFFFFF').fontSize(8.5).font('Helvetica-Bold');
  doc.text('Jurisdiction', tableX + 6, yPos + 5, { width: 110 });
  doc.text('Station / LC Gate', tableX + 120, yPos + 5, { width: 140 });
  doc.text('Gates', tableX + 265, yPos + 5, { width: 45, align: 'center' });
  doc.text('Operations', tableX + 315, yPos + 5, { width: 65, align: 'right' });
  doc.text('Open Count', tableX + 385, yPos + 5, { width: 65, align: 'right' });
  doc.text('Close Count', tableX + 455, yPos + 5, { width: 65, align: 'right' });
  doc.text('Total Open Time', tableX + 525, yPos + 5, { width: 85, align: 'right' });
  doc.text('Avg Open', tableX + 615, yPos + 5, { width: 65, align: 'right' });
  doc.text('Delays (>15m)', tableX + 685, yPos + 5, { width: 80, align: 'right' });

  yPos += 20;

  for (const zn of data.hierarchy) {
    if (yPos > doc.page.height - 50) {
      doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
      drawHolisticHeader(doc, false);
      yPos = 36;
    }
    doc.rect(tableX, yPos, tableWidth, 16).fill('#E0F2FE');
    doc.fillColor('#0369A1').fontSize(8.5).font('Helvetica-Bold');
    doc.text(`Zone: ${zn.zone}`, tableX + 6, yPos + 3, { width: 255 });
    doc.text(String(zn.gatesCount), tableX + 265, yPos + 3, { width: 45, align: 'center' });
    doc.text(String(zn.totalOperations), tableX + 315, yPos + 3, { width: 65, align: 'right' });
    doc.text(String(zn.openCount), tableX + 385, yPos + 3, { width: 65, align: 'right' });
    doc.text(String(zn.closeCount), tableX + 455, yPos + 3, { width: 65, align: 'right' });
    doc.text(zn.totalOpenFormatted, tableX + 525, yPos + 3, { width: 85, align: 'right' });
    doc.text(zn.avgOpenFormatted, tableX + 615, yPos + 3, { width: 65, align: 'right' });
    doc.text(String(zn.extendedDelaysCount), tableX + 685, yPos + 3, { width: 80, align: 'right' });
    yPos += 17;

    for (const div of zn.divisions) {
      if (yPos > doc.page.height - 50) {
        doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
        drawHolisticHeader(doc, false);
        yPos = 36;
      }
      doc.rect(tableX, yPos, tableWidth, 16).fill('#F1F5F9');
      doc.fillColor('#334155').fontSize(8.5).font('Helvetica-Bold');
      doc.text(`  Division: ${div.division}`, tableX + 16, yPos + 3, { width: 245 });
      doc.text(String(div.gatesCount), tableX + 265, yPos + 3, { width: 45, align: 'center' });
      doc.text(String(div.totalOperations), tableX + 315, yPos + 3, { width: 65, align: 'right' });
      doc.text(String(div.openCount), tableX + 385, yPos + 3, { width: 65, align: 'right' });
      doc.text(String(div.closeCount), tableX + 455, yPos + 3, { width: 65, align: 'right' });
      doc.text(div.totalOpenFormatted, tableX + 525, yPos + 3, { width: 85, align: 'right' });
      doc.text(div.avgOpenFormatted, tableX + 615, yPos + 3, { width: 65, align: 'right' });
      doc.text(String(div.extendedDelaysCount), tableX + 685, yPos + 3, { width: 80, align: 'right' });
      yPos += 17;

      for (const st of div.stations) {
        if (yPos > doc.page.height - 50) {
          doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
          drawHolisticHeader(doc, false);
          yPos = 36;
        }
        doc.fillColor('#475569').fontSize(8.5).font('Helvetica-Bold');
        doc.text(`    Station: ${st.stationName} (${st.stationCode})`, tableX + 24, yPos + 3, { width: 235 });
        doc.text(String(st.gatesCount), tableX + 265, yPos + 3, { width: 45, align: 'center' });
        doc.text(String(st.totalOperations), tableX + 315, yPos + 3, { width: 65, align: 'right' });
        doc.text(String(st.openCount), tableX + 385, yPos + 3, { width: 65, align: 'right' });
        doc.text(String(st.closeCount), tableX + 455, yPos + 3, { width: 65, align: 'right' });
        doc.text(st.totalOpenFormatted, tableX + 525, yPos + 3, { width: 85, align: 'right' });
        doc.text(st.avgOpenFormatted, tableX + 615, yPos + 3, { width: 65, align: 'right' });
        doc.text(String(st.extendedDelaysCount), tableX + 685, yPos + 3, { width: 80, align: 'right' });
        yPos += 16;

        for (const g of st.gates) {
          if (yPos > doc.page.height - 50) {
            doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
            drawHolisticHeader(doc, false);
            yPos = 36;
          }
          doc.fillColor('#0F172A').fontSize(8).font('Helvetica');
          doc.text(`      ${g.lcNumber} - ${g.locationName}`, tableX + 34, yPos + 2, { width: 225 });
          doc.text('1', tableX + 265, yPos + 2, { width: 45, align: 'center' });
          doc.text(String(g.totalOperations), tableX + 315, yPos + 2, { width: 65, align: 'right' });
          doc.text(String(g.openCount), tableX + 385, yPos + 2, { width: 65, align: 'right' });
          doc.text(String(g.closeCount), tableX + 455, yPos + 2, { width: 65, align: 'right' });
          doc.text(g.totalOpenFormatted, tableX + 525, yPos + 2, { width: 85, align: 'right' });
          doc.text(g.avgOpenFormatted, tableX + 615, yPos + 2, { width: 65, align: 'right' });
          doc.text(String(g.extendedDelaysCount), tableX + 685, yPos + 2, { width: 80, align: 'right' });

          doc.strokeColor('#E2E8F0').lineWidth(0.5).moveTo(tableX + 24, yPos + 14).lineTo(tableX + tableWidth, yPos + 14).stroke();
          yPos += 15;
        }
      }
    }
  }

  doc.end();
}

export interface DeviceMappingReportRow {
  sNo: number;
  lcGateNumber: string;
  locationName: string;
  division: string;
  zone: string;
  masterSerialNumber: string;
  masterId: number | null;
  awsIotThingName: string;
  simDetails: string;
  iccid: string;
}

export interface DeviceMappingReportData {
  generatedAt: Date;
  totalDevices: number;
  rows: DeviceMappingReportRow[];
}

/**
 * ─────────────────────────────────────────────────────────────
 * EXPORT GATE & DEVICE MAPPING REPORT: EXCEL (.xlsx)
 * ─────────────────────────────────────────────────────────────
 */
export async function exportDeviceMappingExcel(
  res: Response,
  data: DeviceMappingReportData,
  options: { filenameBase: string }
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Indian Railways - Level Crossing Safety Platform';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Gate & Device Mapping', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const lastColLetter = 'G'; // 7 columns (A to G)

  // Row 1: Government Header
  sheet.mergeCells(`A1:${lastColLetter}1`);
  const r1 = sheet.getCell('A1');
  r1.value = 'GOVERNMENT OF INDIA — MINISTRY OF RAILWAYS';
  r1.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r1.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 24;

  // Row 2: Title
  sheet.mergeCells(`A2:${lastColLetter}2`);
  const r2 = sheet.getCell('A2');
  r2.value = 'INDIAN RAILWAYS — GATE & IOT CONTROLLER MAPPING REGISTRY';
  r2.font = { name: 'Calibri', size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003580' } };
  r2.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 30;

  // Row 3: Subtitle
  sheet.mergeCells(`A3:${lastColLetter}3`);
  const r3 = sheet.getCell('A3');
  r3.value = 'Physical Master Controller · AWS IoT Thing · SIM ICCID Linkage (Developer Inventory)';
  r3.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF003580' } };
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8D5A3' } };
  r3.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(3).height = 20;

  // Tricolor Ribbons
  sheet.mergeCells(`A4:${lastColLetter}4`);
  sheet.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } };
  sheet.getRow(4).height = 4;

  sheet.mergeCells(`A5:${lastColLetter}5`);
  sheet.getCell('A5').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet.getRow(5).height = 2;

  sheet.mergeCells(`A6:${lastColLetter}6`);
  sheet.getCell('A6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF046A38' } };
  sheet.getRow(6).height = 4;

  // Row 7: Metadata row
  sheet.mergeCells(`A7:${lastColLetter}7`);
  const r7 = sheet.getCell('A7');
  const genStr = new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  r7.value = `Generated On: ${genStr} IST   |   Target Role: Developer (Technical Inventory)   |   Total Controller Mappings: ${data.totalDevices}`;
  r7.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF475569' } };
  r7.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  r7.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(7).height = 20;

  // Row 8: Table Header
  const headers = [
    { label: 'S.No.', width: 8, align: 'center' },
    { label: 'LC Gate', width: 26, align: 'left' },
    { label: 'Division / Zone', width: 24, align: 'left' },
    { label: 'Master Unit Serial (ID)', width: 24, align: 'center' },
    { label: 'AWS IoT Thing Name', width: 22, align: 'center' },
    { label: 'SIM Details', width: 18, align: 'center' },
    { label: 'SIM ICCID', width: 26, align: 'center' }
  ];

  const headerRow = sheet.getRow(8);
  headerRow.values = headers.map(h => h.label);
  headerRow.height = 24;
  headerRow.eachCell((cell, colNum) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.alignment = { horizontal: (headers[colNum - 1]?.align as any) || 'center', vertical: 'middle' };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'medium', color: { argb: 'FF003580' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
    };
  });

  // Data rows
  let curRow = 9;
  for (let i = 0; i < data.rows.length; i++) {
    const r = data.rows[i];
    const dRow = sheet.getRow(curRow);
    dRow.values = [
      r.sNo,
      r.lcGateNumber,
      r.division && r.zone ? `${r.division} · ${r.zone}` : (r.division || r.zone || '-'),
      r.masterSerialNumber,
      r.awsIotThingName,
      r.simDetails,
      r.iccid
    ];
    dRow.height = 20;

    const isEven = i % 2 === 0;
    dRow.eachCell((cell, colNum) => {
      cell.font = { name: 'Calibri', size: 10 };
      cell.alignment = { horizontal: (headers[colNum - 1]?.align as any) || 'left', vertical: 'middle' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
      if (!isEven) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
      if (colNum === 4 || colNum === 5) {
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF0B3C7A' } };
      }
      if (colNum === 6) {
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF046A38' } };
      }
      if (colNum === 7) {
        cell.font = { name: 'Consolas', size: 9.5, color: { argb: 'FF334155' } };
      }
    });
    curRow++;
  }

  // Set widths
  headers.forEach((h, idx) => {
    sheet.getColumn(idx + 1).width = h.width;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.xlsx"`);
  res.setHeader('Content-Length', buffer.byteLength.toString());
  return res.status(200).send(Buffer.from(buffer));
}

/**
 * ─────────────────────────────────────────────────────────────
 * EXPORT GATE & DEVICE MAPPING REPORT: PDF (.pdf)
 * ─────────────────────────────────────────────────────────────
 */
export async function exportDeviceMappingPdf(
  res: Response,
  data: DeviceMappingReportData,
  options: { filenameBase: string }
) {
  const doc = new PDFDocument({
    bufferPages: true,
    layout: 'landscape',
    size: 'A4',
    margin: 36,
    info: {
      Title: 'LC Gate · Master Unit · AWS IoT Thing Mapping Report',
      Author: 'Indian Railways - Level Crossing Safety Platform',
    }
  });

  const chunks: Buffer[] = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    const pdfBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    return res.status(200).send(pdfBuffer);
  });
  doc.on('error', pdfErr => {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'PDF Generation Error', message: pdfErr.message });
    }
  });

  const { irLogoPath, azadiLogoPath } = resolveLogos();

  function drawMappingHeader(docInstance: typeof doc, isFirstPage: boolean) {
    if (isFirstPage) {
      docInstance.rect(0, 0, docInstance.page.width, 90).fill(NAVY_BLUE);

      if (irLogoPath) {
        try { docInstance.image(irLogoPath, 16, 11, { fit: [72, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }
      if (azadiLogoPath) {
        try { docInstance.image(azadiLogoPath, docInstance.page.width - 100, 11, { fit: [84, 68], align: 'center', valign: 'center' }); } catch (_) {}
      }

      docInstance.fillColor('white').fontSize(9.5).font('Helvetica')
        .text('Government of India', 0, 11, { align: 'center' })
        .text('Ministry of Railways', 0, 24, { align: 'center' });

      docInstance.fillColor('white').fontSize(17).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS', 0, 37, { align: 'center' });

      docInstance.fillColor(GOLDEN_SAND).fontSize(10.5).font('Helvetica')
        .text('LC Gate · Master Unit · AWS IoT Thing Mapping Registry', 0, 59, { align: 'center' });

      docInstance.rect(0, 75, docInstance.page.width, 5).fill(SAFFRON);
      docInstance.rect(0, 80, docInstance.page.width, 5).fill('white');
      docInstance.rect(0, 85, docInstance.page.width, 5).fill(DEEP_GREEN);
    } else {
      docInstance.rect(0, 0, docInstance.page.width, 24).fill(NAVY_BLUE);
      docInstance.fillColor('white').fontSize(9).font('Helvetica-Bold')
        .text('INDIAN RAILWAYS — Gate & IoT Controller Mapping Registry (Continued)', 0, 7, { align: 'center' });
      docInstance.rect(0, 24, docInstance.page.width, 2).fill(SAFFRON);
    }
  }

  drawMappingHeader(doc, true);

  const tableX = 36;
  const tableWidth = doc.page.width - 72;
  let yPos = 102;

  // Metadata ribbon
  doc.rect(tableX, yPos, tableWidth, 20).fill('#F1F5F9');
  doc.fillColor('#475569').fontSize(8.5).font('Helvetica');
  const genStr = new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  doc.text(`Generated On: ${genStr} IST   |   Target Role: Developer (Technical Inventory)   |   Total Controller Mappings: ${data.totalDevices}`, tableX + 10, yPos + 5);
  yPos += 26;

  const cols = [
    { label: 'S.No.', width: 40, align: 'center' },
    { label: 'LC Gate', width: 140, align: 'left' },
    { label: 'Division / Zone', width: 130, align: 'left' },
    { label: 'Master Unit Serial (ID)', width: 120, align: 'left' },
    { label: 'AWS IoT Thing Name', width: 120, align: 'left' },
    { label: 'SIM Details', width: 90, align: 'center' },
    { label: 'SIM ICCID', width: 129, align: 'left' },
  ];

  function drawTableHeader() {
    doc.rect(tableX, yPos, tableWidth, 20).fill(HEADER_BG);
    doc.fillColor('white').fontSize(8.5).font('Helvetica-Bold');
    let curX = tableX;
    for (const c of cols) {
      doc.text(c.label, curX + 4, yPos + 5, { width: c.width - 8, align: c.align as any });
      curX += c.width;
    }
    yPos += 20;
  }

  drawTableHeader();

  // Draw rows
  for (let i = 0; i < data.rows.length; i++) {
    const row = data.rows[i];
    if (yPos > doc.page.height - 45) {
      doc.addPage({ margin: 36, size: 'A4', layout: 'landscape' });
      drawMappingHeader(doc, false);
      yPos = 36;
      drawTableHeader();
    }

    const isEven = i % 2 === 0;
    if (!isEven) {
      doc.rect(tableX, yPos, tableWidth, 18).fill('#F8FAFC');
    }

    // Border line bottom
    doc.strokeColor('#E2E8F0').lineWidth(0.5).moveTo(tableX, yPos + 18).lineTo(tableX + tableWidth, yPos + 18).stroke();

    let curX = tableX;
    
    // S.No.
    doc.fillColor('#64748B').fontSize(8).font('Helvetica')
      .text(String(row.sNo), curX + 2, yPos + 4, { width: cols[0].width - 4, align: 'center' });
    curX += cols[0].width;

    // LC Gate
    doc.fillColor('#0F172A').fontSize(8.5).font('Helvetica-Bold')
      .text(row.lcGateNumber, curX + 4, yPos + 4, { width: cols[1].width - 8, align: 'left' });
    curX += cols[1].width;

    // Division / Zone
    const divZone = row.division && row.zone ? `${row.division} · ${row.zone}` : (row.division || row.zone || '-');
    doc.fillColor('#475569').fontSize(8).font('Helvetica')
      .text(divZone, curX + 4, yPos + 4, { width: cols[2].width - 8, align: 'left' });
    curX += cols[2].width;

    // Master Unit Serial
    doc.fillColor('#0B3C7A').fontSize(8).font('Helvetica-Bold')
      .text(row.masterSerialNumber, curX + 4, yPos + 4, { width: cols[3].width - 8, align: 'left' });
    curX += cols[3].width;

    // AWS IoT Thing
    doc.fillColor('#0B3C7A').fontSize(8).font('Helvetica-Bold')
      .text(row.awsIotThingName, curX + 4, yPos + 4, { width: cols[4].width - 8, align: 'left' });
    curX += cols[4].width;

    // SIM Details
    doc.fillColor('#046A38').fontSize(8).font('Helvetica-Bold')
      .text(row.simDetails, curX + 2, yPos + 4, { width: cols[5].width - 4, align: 'center' });
    curX += cols[5].width;

    // SIM ICCID
    doc.fillColor('#334155').fontSize(8).font('Courier')
      .text(row.iccid, curX + 4, yPos + 4, { width: cols[6].width - 8, align: 'left' });

    yPos += 18;
  }

  // Footer page numbers
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.fillColor('#94A3B8').fontSize(8).font('Helvetica')
      .text(`Page ${i + 1} of ${pages.count}   |   Ministry of Railways — Safety & Telemetry Directorate   |   Developer Confidential`,
        36, doc.page.height - 24, { align: 'center', width: doc.page.width - 72 });
  }

  doc.end();
}

/**
 * ─────────────────────────────────────────────────────────────
 * EXPORT GATE & DEVICE MAPPING REPORT: CSV (.csv)
 * ─────────────────────────────────────────────────────────────
 */
export function exportDeviceMappingCsv(
  res: Response,
  data: DeviceMappingReportData,
  options: { filenameBase: string }
) {
  const headers = ['S.No.', 'LC Gate', 'Division', 'Zone', 'Master Unit Serial (ID)', 'AWS IoT Thing Name', 'SIM Details', 'SIM ICCID'];
  const lines: string[] = [headers.map(h => `"${h}"`).join(',')];

  for (const r of data.rows) {
    const row = [
      r.sNo,
      r.lcGateNumber,
      r.division,
      r.zone,
      r.masterSerialNumber,
      r.awsIotThingName,
      r.simDetails,
      r.iccid
    ];
    lines.push(row.map(val => `"${String(val ?? '').replace(/"/g, '""')}"`).join(','));
  }

  const csvBuffer = Buffer.from(lines.join('\r\n'), 'utf-8');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${options.filenameBase}.csv"`);
  res.setHeader('Content-Length', csvBuffer.byteLength.toString());
  return res.status(200).send(csvBuffer);
}


