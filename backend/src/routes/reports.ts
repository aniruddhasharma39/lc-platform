import { Router, Response } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { getAllDescendantScopeGroupIds } from '../lib/scopeHierarchy';

const router = Router();
router.use(authenticate);

/**
 * Format duration in seconds to human readable string: e.g. "2h 15m 30s"
 */
function formatDurationHuman(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Helper to resolve user's authorized scope groups and gate IDs
 */
async function resolveUserAccess(req: AuthRequest) {
  const roleName = (req.user?.role || '').toLowerCase();
  const isDeveloper = roleName.includes('developer') || roleName.includes('admin');

  // 1. Fetch user's directly assigned scope groups
  const userScopes = await prisma.scopeGroupUser.findMany({
    where: { userId: req.user!.id },
    include: {
      scopeGroup: {
        select: { id: true, name: true, color: true, parentId: true }
      }
    }
  });

  const directScopeIds = userScopes.map(s => s.scopeGroupId);

  // If user has assigned scope groups, resolve hierarchy
  if (directScopeIds.length > 0) {
    const accessibleScopeIds = await getAllDescendantScopeGroupIds(directScopeIds);

    const accessibleGroups = await prisma.scopeGroup.findMany({
      where: { id: { in: accessibleScopeIds } },
      include: {
        _count: { select: { gates: true } },
        parent: { select: { id: true, name: true } },
        gates: {
          include: {
            gate: {
              select: { id: true, lcNumber: true, locationName: true, name: true, zone: true, division: true }
            }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const accessibleGateIds = Array.from(
      new Set(accessibleGroups.flatMap(g => g.gates.map(link => link.gateId)))
    );

    return {
      isDeveloper,
      hasAssignedScopes: true,
      accessibleScopeIds,
      accessibleGroups,
      accessibleGateIds,
    };
  }

  // If Developer has no explicit scope assignments, they have global access
  if (isDeveloper) {
    const allGroups = await prisma.scopeGroup.findMany({
      include: {
        _count: { select: { gates: true } },
        parent: { select: { id: true, name: true } },
        gates: {
          include: {
            gate: {
              select: { id: true, lcNumber: true, locationName: true, name: true, zone: true, division: true }
            }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const allGates = await prisma.lCGate.findMany({
      select: { id: true }
    });

    return {
      isDeveloper: true,
      hasAssignedScopes: false,
      accessibleScopeIds: allGroups.map(g => g.id),
      accessibleGroups: allGroups,
      accessibleGateIds: allGates.map(g => g.id),
    };
  }

  // Non-developer with no assigned clusters has no access
  return {
    isDeveloper: false,
    hasAssignedScopes: false,
    accessibleScopeIds: [],
    accessibleGroups: [],
    accessibleGateIds: [],
  };
}

/**
 * Helper to resolve target gate IDs based on user's authorized access,
 * requested scopeGroupIds ('all' or array of numbers), and requested gateIds ('all' or array).
 */
async function resolveFilteredGateIds(
  access: Awaited<ReturnType<typeof resolveUserAccess>>,
  requestedScopeGroupIdsParam?: string | null,
  requestedGateIdsParam?: string | null
): Promise<{ targetGateIds: number[]; targetScopeGroupIds: number[] }> {
  // 1. Determine active scope groups
  let targetScopeGroupIds: number[] = [];

  if (requestedScopeGroupIdsParam && requestedScopeGroupIdsParam !== 'all') {
    const parsedIds = requestedScopeGroupIdsParam
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));

    if (access.isDeveloper) {
      targetScopeGroupIds = parsedIds;
    } else {
      // Strictly filter to authorized scope groups only
      targetScopeGroupIds = parsedIds.filter(id => access.accessibleScopeIds.includes(id));
    }
  } else {
    // 'all' or omitted
    targetScopeGroupIds = access.accessibleScopeIds;
  }

  // 2. Resolve gates belonging to target scope groups
  let poolGateIds: number[] = [];
  if (targetScopeGroupIds.length > 0) {
    const links = await prisma.scopeGroupGate.findMany({
      where: { scopeGroupId: { in: targetScopeGroupIds } },
      select: { gateId: true }
    });
    poolGateIds = Array.from(new Set(links.map(l => l.gateId)));
  }

  // If Developer requested 'all' with no scope groups or no gate links, include all accessible gates
  if (access.isDeveloper && (!requestedScopeGroupIdsParam || requestedScopeGroupIdsParam === 'all') && poolGateIds.length === 0) {
    poolGateIds = access.accessibleGateIds;
  }

  // 3. Filter down by requested gateIds if specified
  let targetGateIds: number[] = poolGateIds;

  if (requestedGateIdsParam && requestedGateIdsParam !== 'all') {
    const parsedGateIds = requestedGateIdsParam
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));

    if (access.isDeveloper && poolGateIds.length === 0) {
      targetGateIds = parsedGateIds;
    } else {
      targetGateIds = parsedGateIds.filter(id => poolGateIds.includes(id));
    }
  }

  return { targetGateIds, targetScopeGroupIds };
}

/**
 * 1. GET /api/v1/reports/clusters
 * Returns the hierarchical tree of clusters and their child gates accessible to the user
 */
router.get('/clusters', async (req: AuthRequest, res, next) => {
  try {
    const access = await resolveUserAccess(req);

    if (!access.isDeveloper && access.accessibleScopeIds.length === 0) {
      return res.json({
        clusters: [],
        isDeveloper: false,
        message: 'No clusters are assigned to your account. Please contact an administrator.'
      });
    }

    const clustersWithDetails = access.accessibleGroups.map(group => ({
      id: group.id,
      name: group.name,
      color: group.color || '#0B3C7A',
      parentId: group.parentId,
      parentName: group.parent?.name || null,
      gateCount: group.gates.length,
      gates: group.gates.map(l => ({
        id: l.gate.id,
        lcNumber: l.gate.lcNumber,
        name: l.gate.name,
        locationName: l.gate.locationName,
        zone: l.gate.zone,
        division: l.gate.division,
      }))
    }));

    res.json({
      clusters: clustersWithDetails,
      isDeveloper: access.isDeveloper
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Core query helper to fetch operational events with date range, multi-scope, multi-gate, and filters
 */
async function fetchFilteredOperationalEvents(req: AuthRequest) {
  const access = await resolveUserAccess(req);

  if (!access.isDeveloper && access.accessibleScopeIds.length === 0) {
    return {
      access,
      targetGateIds: [],
      targetScopeGroupIds: [],
      startDateStr: '',
      endDateStr: '',
      metrics: {
        totalOperations: 0,
        totalDurationSeconds: 0,
        totalDurationFormatted: '0s',
        avgDurationSeconds: 0,
        avgDurationFormatted: '0s',
        extendedDelaysCount: 0,
        currentlyOpenCount: 0,
        reportingGatesCount: 0
      },
      events: []
    };
  }

  const scopeGroupIdsParam = (req.query.scopeGroupIds || req.query.scopeGroupId) as string | undefined;
  const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;

  const { targetGateIds, targetScopeGroupIds } = await resolveFilteredGateIds(
    access,
    scopeGroupIdsParam,
    gateIdsParam
  );

  // Parse Date Range (Default: Last 7 Days)
  const today = new Date();
  const defaultEnd = today.toISOString().split('T')[0];
  const defaultStartObj = new Date(today);
  defaultStartObj.setDate(today.getDate() - 7);
  const defaultStart = defaultStartObj.toISOString().split('T')[0];

  const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate
    ? req.query.startDate
    : (typeof req.query.date === 'string' && req.query.date ? req.query.date : defaultStart);

  const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate
    ? req.query.endDate
    : (typeof req.query.date === 'string' && req.query.date ? req.query.date : defaultEnd);

  const [sY, sM, sD] = startDateStr.split('-').map(Number);
  const [eY, eM, eD] = endDateStr.split('-').map(Number);

  const startUtc = new Date(Date.UTC(sY || today.getFullYear(), (sM || 1) - 1, sD || 1, 0, 0, 0, 0));
  const endUtc = new Date(Date.UTC(eY || today.getFullYear(), (eM || 1) - 1, eD || 1, 23, 59, 59, 999));

  // Filters
  const statusFilter = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL';
  const shiftFilter = typeof req.query.shift === 'string' ? req.query.shift.toUpperCase() : 'ALL';
  const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
  const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'openedAt';
  const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc';

  if (targetGateIds.length === 0) {
    return {
      access,
      targetGateIds: [],
      targetScopeGroupIds,
      startDateStr,
      endDateStr,
      metrics: {
        totalOperations: 0,
        totalDurationSeconds: 0,
        totalDurationFormatted: '0s',
        avgDurationSeconds: 0,
        avgDurationFormatted: '0s',
        extendedDelaysCount: 0,
        currentlyOpenCount: 0,
        reportingGatesCount: 0
      },
      events: []
    };
  }

  const whereClause: any = {
    gateId: { in: targetGateIds },
    openedAt: {
      gte: startUtc,
      lte: endUtc
    }
  };

  if (statusFilter !== 'ALL') {
    whereClause.status = statusFilter;
  }

  // Fetch raw events with Gate and Scope Group associations
  const rawEvents = await prisma.lCGateEvent.findMany({
    where: whereClause,
    include: {
      gate: {
        select: {
          id: true,
          lcNumber: true,
          locationName: true,
          name: true,
          zone: true,
          division: true,
          scopeGroups: {
            include: { scopeGroup: { select: { id: true, name: true, color: true } } }
          }
        }
      }
    },
    orderBy: {
      [sortBy === 'durationSeconds' ? 'durationSeconds' : 'openedAt']: sortOrder
    }
  });

  // Filter by Shift and Search query in memory
  let filteredEvents = rawEvents.filter(ev => {
    // Shift filter (IST)
    if (shiftFilter !== 'ALL') {
      const utcTime = new Date(ev.openedAt).getTime();
      const istHour = new Date(utcTime + (3600000 * 5.5)).getUTCHours();
      if (shiftFilter === 'MORNING' && (istHour < 6 || istHour >= 14)) return false;
      if (shiftFilter === 'EVENING' && (istHour < 14 || istHour >= 22)) return false;
      if (shiftFilter === 'NIGHT' && (istHour >= 6 && istHour < 22)) return false;
    }

    // Search query
    if (searchQuery) {
      const matchLc = ev.gate.lcNumber.toLowerCase().includes(searchQuery);
      const matchLoc = (ev.gate.locationName || '').toLowerCase().includes(searchQuery);
      const matchName = (ev.gate.name || '').toLowerCase().includes(searchQuery);

      if (!matchLc && !matchLoc && !matchName) {
        return false;
      }
    }

    return true;
  });

  // In-memory sort for non-DB direct fields
  if (sortBy === 'lcNumber') {
    filteredEvents.sort((a, b) => {
      const cmp = a.gate.lcNumber.localeCompare(b.gate.lcNumber);
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  } else if (sortBy === 'closedAt') {
    filteredEvents.sort((a, b) => {
      const timeA = a.closedAt ? new Date(a.closedAt).getTime() : 0;
      const timeB = b.closedAt ? new Date(b.closedAt).getTime() : 0;
      return sortOrder === 'asc' ? timeA - timeB : timeB - timeA;
    });
  } else if (sortBy === 'status') {
    filteredEvents.sort((a, b) => {
      const cmp = (a.status || '').localeCompare(b.status || '');
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }

  // Compute KPI metrics
  const totalOperations = filteredEvents.length;
  let totalDurationSeconds = 0;
  let extendedDelaysCount = 0;
  let currentlyOpenCount = 0;

  filteredEvents.forEach(ev => {
    if (ev.durationSeconds) totalDurationSeconds += ev.durationSeconds;
    if (ev.status === 'EXTENDED_DELAY') extendedDelaysCount += 1;
    if (ev.status === 'OPEN') currentlyOpenCount += 1;
  });

  const avgDurationSeconds = totalOperations > 0 ? Math.round(totalDurationSeconds / totalOperations) : 0;

  const metrics = {
    totalOperations,
    totalDurationSeconds,
    totalDurationFormatted: formatDurationHuman(totalDurationSeconds),
    avgDurationSeconds,
    avgDurationFormatted: formatDurationHuman(avgDurationSeconds),
    extendedDelaysCount,
    currentlyOpenCount,
    reportingGatesCount: new Set(filteredEvents.map(e => e.gateId)).size
  };

  return {
    access,
    targetGateIds,
    targetScopeGroupIds,
    startDateStr,
    endDateStr,
    metrics,
    events: filteredEvents
  };
}

/**
 * 2. GET /api/v1/reports/records (and alias /daily-records)
 * Fetches filtered operational records and KPIs for date range, multiple scope groups and gates
 */
const handleGetRecords = async (req: AuthRequest, res: Response, next: any) => {
  try {
    const data = await fetchFilteredOperationalEvents(req);

    res.json({
      dateRange: {
        startDate: data.startDateStr,
        endDate: data.endDateStr,
      },
      filters: {
        scopeGroupIds: data.targetScopeGroupIds,
        gateIds: data.targetGateIds,
        selectedGatesCount: data.targetGateIds.length,
        selectedScopeGroupsCount: data.targetScopeGroupIds.length,
      },
      metrics: data.metrics,
      records: data.events.map(ev => {
        const primaryGroup = ev.gate.scopeGroups[0]?.scopeGroup || null;
        return {
          id: ev.id,
          gateId: ev.gateId,
          lcNumber: ev.gate.lcNumber,
          gateName: ev.gate.name || ev.gate.locationName,
          locationName: ev.gate.locationName,
          zone: ev.gate.zone,
          division: ev.gate.division,
          scopeGroupName: primaryGroup ? primaryGroup.name : 'Unassigned',
          scopeGroupColor: primaryGroup ? primaryGroup.color : '#0B3C7A',
          openedAt: ev.openedAt.toISOString(),
          closedAt: ev.closedAt ? ev.closedAt.toISOString() : null,
          durationSeconds: ev.durationSeconds,
          durationFormatted: ev.durationSeconds ? formatDurationHuman(ev.durationSeconds) : 'Ongoing (Open)',
          status: ev.status,
          openedBy: ev.openedBy,
          closedBy: ev.closedBy,
          trainNumber: ev.trainNumber,
          remarks: ev.remarks
        };
      })
    });
  } catch (error) {
    next(error);
  }
};

router.get('/records', handleGetRecords);
router.get('/daily-records', handleGetRecords);

/**
 * 3. GET /api/v1/reports/export
 * Downloads either Excel (.xlsx), PDF (.pdf), or RFC-4180 CSV
 */
router.get('/export', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const data = await fetchFilteredOperationalEvents(req);
    const format = (req.query.format as string || 'xlsx').toLowerCase();
    const columnsParam = req.query.columns ? (req.query.columns as string).split(',').map(c => c.trim()) : null;

    // Default column set
    const ALL_COLUMNS = [
      { key: 'scopeGroup', label: 'Cluster / Scope Group' },
      { key: 'lcNumber', label: 'LC Number' },
      { key: 'locationName', label: 'Location Name' },
      { key: 'zone', label: 'Zone' },
      { key: 'division', label: 'Division' },
      { key: 'openedDate', label: 'Date' },
      { key: 'openedTime', label: 'Opened Time (IST)' },
      { key: 'closedTime', label: 'Closed Time (IST)' },
      { key: 'durationFormatted', label: 'Duration' },
      { key: 'durationSeconds', label: 'Duration (Sec)' },
      { key: 'status', label: 'Status' }
    ];

    const activeColumns = columnsParam && columnsParam.length > 0
      ? ALL_COLUMNS.filter(c => columnsParam.includes(c.key))
      : ALL_COLUMNS;

    const filenameBase = `LC_Gate_Report_${data.startDateStr}_to_${data.endDateStr}`;

    // Map rows
    const rows = data.events.map(ev => {
      const primaryGroup = ev.gate.scopeGroups[0]?.scopeGroup || null;
      const openedDateObj = new Date(ev.openedAt);
      const openedDateStr = openedDateObj.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
      const openedTimeStr = openedDateObj.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
      const closedTimeStr = ev.closedAt
        ? new Date(ev.closedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
        : 'STILL OPEN';

      return {
        scopeGroup: primaryGroup?.name || 'Unassigned',
        lcNumber: ev.gate.lcNumber,
        locationName: ev.gate.locationName,
        zone: ev.gate.zone || '-',
        division: ev.gate.division || '-',
        openedDate: openedDateStr,
        openedTime: openedTimeStr,
        closedTime: closedTimeStr,
        durationFormatted: ev.durationSeconds ? formatDurationHuman(ev.durationSeconds) : 'In Progress',
        durationSeconds: ev.durationSeconds ?? '-',
        status: ev.status
      };
    });

    // ─────────────────────────────────────────────────────────────
    // FORMAT 1: EXCEL (.xlsx) using ExcelJS
    // ─────────────────────────────────────────────────────────────
    if (format === 'xlsx' || format === 'excel') {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'LC Platform';
      workbook.created = new Date();

      const sheet = workbook.addWorksheet('Operations Report', {
        pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
      });

      // 1. Title Block
      sheet.mergeCells('A1', 'H1');
      const titleCell = sheet.getCell('A1');
      titleCell.value = 'INDIAN RAILWAYS / LC GATE PLATFORM';
      titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3C7A' } };
      titleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      sheet.getRow(1).height = 36;

      sheet.mergeCells('A2', 'H2');
      const subtitleCell = sheet.getCell('A2');
      subtitleCell.value = `Level Crossing Operational Audit & History Log (${data.startDateStr} to ${data.endDateStr})`;
      subtitleCell.font = { name: 'Calibri', size: 12, italic: true, color: { argb: 'FF475569' } };
      sheet.getRow(2).height = 24;

      // 2. Metadata / KPI Summary Block
      sheet.getCell('A4').value = 'Date Range:';
      sheet.getCell('B4').value = `${data.startDateStr} to ${data.endDateStr}`;
      sheet.getCell('C4').value = 'Total Operations:';
      sheet.getCell('D4').value = data.metrics.totalOperations;
      sheet.getCell('E4').value = 'Total Open Time:';
      sheet.getCell('F4').value = data.metrics.totalDurationFormatted;
      sheet.getCell('G4').value = 'Extended Delays (>15m):';
      sheet.getCell('H4').value = data.metrics.extendedDelaysCount;

      ['A4', 'C4', 'E4', 'G4'].forEach(cell => {
        sheet.getCell(cell).font = { bold: true, color: { argb: 'FF0B3C7A' } };
      });
      sheet.getRow(4).height = 20;

      // Spacer
      sheet.getRow(5).height = 10;

      // 3. Table Header
      const headerRowIndex = 6;
      const headerRow = sheet.getRow(headerRowIndex);
      headerRow.values = activeColumns.map(c => c.label);
      headerRow.height = 28;

      headerRow.eachCell((cell) => {
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'medium', color: { argb: 'FF0B3C7A' } }
        };
      });

      // 4. Data Rows
      rows.forEach((r, idx) => {
        const rowValues = activeColumns.map(c => (r as any)[c.key]);
        const dataRow = sheet.addRow(rowValues);
        dataRow.height = 22;

        const isEven = idx % 2 === 0;
        dataRow.eachCell((cell, colNum) => {
          cell.font = { name: 'Calibri', size: 10 };
          cell.alignment = { vertical: 'middle', horizontal: colNum === 2 ? 'center' : 'left' };
          cell.border = {
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };
          if (!isEven) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
          }

          // Highlight status cell
          const colKey = activeColumns[colNum - 1]?.key;
          if (colKey === 'status') {
            const val = String(cell.value).toUpperCase();
            if (val === 'CLOSED') {
              cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF166534' } };
            } else if (val === 'EXTENDED_DELAY') {
              cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFB45309' } };
            } else if (val === 'OPEN') {
              cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFDC2626' } };
            }
          }
        });
      });

      // Auto-fit column widths
      activeColumns.forEach((col, idx) => {
        let maxLen = col.label.length || 10;
        rows.forEach(r => {
          const val = String((r as any)[col.key] || '');
          if (val.length > maxLen) maxLen = Math.min(val.length, 35);
        });
        sheet.getColumn(idx + 1).width = Math.max(maxLen + 4, 12);
      });

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
      res.setHeader('Content-Length', buffer.byteLength.toString());
      return res.status(200).send(Buffer.from(buffer));
    }

    // ─────────────────────────────────────────────────────────────
    // FORMAT 2: PDF (.pdf) using PDFKit
    // ─────────────────────────────────────────────────────────────
    if (format === 'pdf') {
      const doc = new PDFDocument({
        bufferPages: true,
        layout: 'landscape',
        size: 'A4',
        margin: 36,
        info: {
          Title: `LC Gate Operations Report (${data.startDateStr} - ${data.endDateStr})`,
          Author: 'LC Platform',
        }
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length.toString());
        return res.status(200).send(pdfBuffer);
      });
      doc.on('error', (pdfErr) => {
        if (!res.headersSent) {
          return res.status(500).json({ error: 'PDF Generation Error', message: pdfErr.message });
        }
      });

      // Header Banner
      doc.rect(36, 36, doc.page.width - 72, 44).fill('#0B3C7A');
      doc.fillColor('#FFFFFF')
        .fontSize(16)
        .font('Helvetica-Bold')
        .text('INDIAN RAILWAYS / LEVEL CROSSING PLATFORM', 48, 48);

      doc.fillColor('#E2E8F0')
        .fontSize(10)
        .font('Helvetica')
        .text(`Operational Logsheet Audit Report | Range: ${data.startDateStr} to ${data.endDateStr}`, 48, 66);

      // KPI Metric Badges
      let yPos = 92;
      const kpiWidth = (doc.page.width - 72 - 30) / 4;
      const kpis = [
        { label: 'TOTAL OPERATIONS', val: `${data.metrics.totalOperations}` },
        { label: 'TOTAL OPEN TIME', val: data.metrics.totalDurationFormatted },
        { label: 'AVERAGE OPEN PACE', val: data.metrics.avgDurationFormatted },
        { label: 'EXTENDED DELAYS (>15m)', val: `${data.metrics.extendedDelaysCount}` },
      ];

      kpis.forEach((kpi, i) => {
        const xPos = 36 + i * (kpiWidth + 10);
        doc.rect(xPos, yPos, kpiWidth, 36).fillAndStroke('#F1F5F9', '#CBD5E1');
        doc.fillColor('#475569').fontSize(7.5).font('Helvetica-Bold').text(kpi.label, xPos + 8, yPos + 6);
        doc.fillColor('#0B3C7A').fontSize(12).font('Helvetica-Bold').text(kpi.val, xPos + 8, yPos + 18);
      });

      // Table Setup
      yPos = 140;
      const pdfCols = activeColumns;
      const colWidth = (doc.page.width - 72) / pdfCols.length;

      // Table Header
      doc.rect(36, yPos, doc.page.width - 72, 22).fill('#1E293B');
      doc.fillColor('#FFFFFF').fontSize(8.5).font('Helvetica-Bold');
      pdfCols.forEach((col, i) => {
        doc.text(col.label, 36 + i * colWidth + 4, yPos + 6, { width: colWidth - 8, align: 'left', lineBreak: false });
      });

      yPos += 22;
      doc.font('Helvetica').fontSize(8);

      if (rows.length === 0) {
        doc.rect(36, yPos, doc.page.width - 72, 30).fill('#F8FAFC');
        doc.fillColor('#64748B').fontSize(10).font('Helvetica-Oblique')
          .text('No operational events recorded for the selected scope groups, gates, and date range.', 36, yPos + 10, {
            align: 'center',
            width: doc.page.width - 72
          });
      } else {
        // Table Rows
        rows.forEach((r, idx) => {
          // Page overflow check
          if (yPos > doc.page.height - 50) {
            doc.addPage({ layout: 'landscape', size: 'A4', margin: 36 });
            yPos = 36;
            // Redraw header on new page
            doc.rect(36, yPos, doc.page.width - 72, 20).fill('#1E293B');
            doc.fillColor('#FFFFFF').fontSize(8.5).font('Helvetica-Bold');
            pdfCols.forEach((col, i) => {
              doc.text(col.label, 36 + i * colWidth + 4, yPos + 5, { width: colWidth - 8, align: 'left', lineBreak: false });
            });
            yPos += 20;
            doc.font('Helvetica').fontSize(8);
          }

          const isEven = idx % 2 === 0;
          doc.rect(36, yPos, doc.page.width - 72, 18).fill(isEven ? '#FFFFFF' : '#F8FAFC');

          pdfCols.forEach((col, i) => {
            const val = String((r as any)[col.key] || '-');
            if (col.key === 'status') {
              doc.fillColor(val === 'CLOSED' ? '#166534' : (val === 'EXTENDED_DELAY' ? '#B45309' : '#DC2626'));
            } else {
              doc.fillColor('#1E293B');
            }
            doc.text(val, 36 + i * colWidth + 4, yPos + 5, { width: colWidth - 8, align: 'left', lineBreak: false });
          });

          // Row border
          doc.moveTo(36, yPos + 18).lineTo(doc.page.width - 36, yPos + 18).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
          yPos += 18;
        });
      }

      // Footer
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#94A3B8').fontSize(7.5).font('Helvetica')
          .text(`Generated on ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST | Level Crossing Automated Telemetry | Page ${i - range.start + 1} of ${range.count}`, 36, doc.page.height - 25, {
            align: 'center',
            width: doc.page.width - 72
          });
      }

      doc.end();
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // FORMAT 3: Standard RFC-4180 CSV
    // ─────────────────────────────────────────────────────────────
    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvHeaders = activeColumns.map(c => escapeCsv(c.label)).join(',');
    const csvRows = rows.map(r => {
      return activeColumns.map(c => escapeCsv((r as any)[c.key])).join(',');
    });

    const csvContent = [csvHeaders, ...csvRows].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
});

/**
 * 4. POST /api/v1/reports/events
 * Record a live or manual gate open/close event
 */
const recordEventSchema = z.object({
  gateId: z.number().int(),
  openedAt: z.string().datetime().optional(),
  closedAt: z.string().datetime().nullable().optional(),
  status: z.enum(['OPEN', 'CLOSED', 'EXTENDED_DELAY']).default('CLOSED'),
  openedBy: z.string().optional(),
  closedBy: z.string().nullable().optional(),
  trainNumber: z.string().optional(),
  remarks: z.string().optional()
});

router.post('/events', async (req: AuthRequest, res, next) => {
  try {
    const data = recordEventSchema.parse(req.body);

    const gate = await prisma.lCGate.findUnique({ where: { id: data.gateId } });
    if (!gate) return res.status(404).json({ error: 'LC Gate not found' });

    const openedAt = data.openedAt ? new Date(data.openedAt) : new Date();
    const closedAt = data.closedAt ? new Date(data.closedAt) : (data.status === 'CLOSED' ? new Date() : null);

    let durationSeconds: number | null = null;
    if (closedAt) {
      durationSeconds = Math.max(0, Math.round((closedAt.getTime() - openedAt.getTime()) / 1000));
    }

    const event = await prisma.lCGateEvent.create({
      data: {
        gateId: data.gateId,
        openedAt,
        closedAt,
        durationSeconds,
        status: durationSeconds && durationSeconds > 900 ? 'EXTENDED_DELAY' : data.status,
        openedBy: data.openedBy || (req.user as any)?.fullName || 'Operator',
        closedBy: data.closedBy || (closedAt ? (req.user as any)?.fullName || 'Operator' : null),
        trainNumber: data.trainNumber,
        remarks: data.remarks
      }
    });

    res.status(201).json(event);
  } catch (error) {
    next(error);
  }
});

export default router;
