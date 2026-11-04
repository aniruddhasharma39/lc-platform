import { Router, Response } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { buildUserGateWhereClause } from '../lib/railwayHierarchy';
import { syncHistoricalTelemetryEvents } from '../lib/telemetryMonitor';
import { getDirectoryRevisionToken } from '../lib/revisionManager';
import {
  bumpReportRevisionInTx,
  recordEventChangeInTx,
  getLatestGateRevisions,
  generateReportETag,
  isETagMatch,
  deleteOperationalEvent,
  deleteOperationalEvents,
  calculateAuthoritativeMetrics,
} from '../lib/reportRevisionManager';
import {
  getFullCycleAnalytics,
  getCountReportAnalytics,
  getDurationReportAnalytics,
  getHolisticReportAnalytics
} from '../lib/cycleReportService';
import {
  exportCompleteLogExcel,
  exportCompleteLogPdf,
  exportCompleteLogCsv,
  exportCycleExcel,
  exportCyclePdf,
  exportCycleCsv,
  exportCountExcel,
  exportCountPdf,
  exportCountCsv,
  exportHolisticExcel,
  exportHolisticPdf,
  exportHolisticCsv
} from '../lib/reportExporter';

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

  // Role-based gate access (no scope groups)
  const whereClause = await buildUserGateWhereClause(req.user, prisma);
  const accessibleGates = await prisma.lCGate.findMany({
    where: whereClause,
    select: { id: true, lcNumber: true, locationName: true, name: true, zone: true, division: true }
  });
  const accessibleGateIds = accessibleGates.map(g => g.id);

  // Present as a single virtual cluster so existing frontend keeps working
  const pseudoGroup: any = {
    id: 0,
    name: 'Assigned LC Gates',
    color: '#0B3C7A',
    parentId: null,
    parent: null,
    gates: accessibleGates.map(g => ({ gate: g })),
    _count: { gates: accessibleGates.length }
  };

  return {
    isDeveloper,
    hasAssignedScopes: false,
    accessibleScopeIds: [],
    accessibleGroups: accessibleGateIds.length > 0 ? [pseudoGroup] : [],
    accessibleGateIds,
  };
}

async function resolveFilteredGateIds(
  access: Awaited<ReturnType<typeof resolveUserAccess>>,
  requestedScopeGroupIdsParam?: string | null,
  requestedGateIdsParam?: string | null
): Promise<{ targetGateIds: number[]; targetScopeGroupIds: number[] }> {
  // Role-based: pool is all accessible gates (no scope groups)
  let poolGateIds: number[] = access.accessibleGateIds;

  // Filter down by requested gateIds if specified
  let targetGateIds: number[] = poolGateIds;

  if (requestedGateIdsParam && requestedGateIdsParam !== 'all') {
    const parsedGateIds = requestedGateIdsParam
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));

    if (access.isDeveloper) {
      targetGateIds = parsedGateIds;
    } else {
      targetGateIds = parsedGateIds.filter(id => poolGateIds.includes(id));
    }
  }

  return { targetGateIds, targetScopeGroupIds: [] };
}


/**
 * 1. GET /api/v1/reports/clusters
 * Returns the hierarchical tree of clusters and their child gates accessible to the user
 */
router.get('/clusters', async (req: AuthRequest, res, next) => {
  try {
    const access = await resolveUserAccess(req);

    if (!access.isDeveloper && access.accessibleGateIds.length === 0) {
      return res.json({
        clusters: [],
        isDeveloper: false,
        message: 'No gates are assigned to your account. Please contact an administrator.'
      });
    }

    const clustersWithDetails = access.accessibleGroups.map(group => ({
      id: group.id,
      name: group.name,
      color: group.color || '#0B3C7A',
      parentId: group.parentId,
      parentName: group.parent?.name || null,
      gateCount: group.gates.length,
      gates: group.gates.map((l: any) => ({
        id: l.gate.id,
        lcNumber: l.gate.lcNumber,
        name: l.gate.name,
        locationName: l.gate.locationName,
        zone: l.gate.zone,
        division: l.gate.division,
      }))
    }));

    const dirToken = await getDirectoryRevisionToken(
      req.user?.id || 0,
      access.accessibleScopeIds,
      access.isDeveloper
    );

    if (isETagMatch(req.headers['if-none-match'], dirToken)) {
      return res.status(304).set('ETag', dirToken).end();
    }

    res.set('ETag', dirToken).json({
      clusters: clustersWithDetails,
      isDeveloper: access.isDeveloper,
      directoryRevisionToken: dirToken,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 1b. GET /api/v1/reports/gates
 * Returns flat list of LC gates accessible to user (role-based)
 */
router.get('/gates', async (req: AuthRequest, res, next) => {
  try {
    const access = await resolveUserAccess(req);
    const whereClause = await buildUserGateWhereClause(req.user, prisma);
    const gates = await prisma.lCGate.findMany({
      where: whereClause,
      select: {
        id: true,
        lcNumber: true,
        name: true,
        locationName: true,
        zone: true,
        division: true,
      },
      orderBy: { lcNumber: 'asc' }
    });
    res.json({ gates, isDeveloper: access.isDeveloper });
  } catch (error) {
    next(error);
  }
});

/**
 * Core query helper to fetch operational events with date range, multi-scope, multi-gate, and filters
 */
async function fetchFilteredOperationalEvents(req: AuthRequest, dbClient: any = prisma) {
  const access = await resolveUserAccess(req);
  const client = (dbClient?.lCGateEvent ? dbClient : prisma) as typeof prisma;

  if (!access.isDeveloper && access.accessibleGateIds.length === 0) {
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

  // Auto-sync historical telemetry transitions if no operational events exist yet for target gates
  const existingCount = await prisma.lCGateEvent.count({
    where: { gateId: { in: targetGateIds } }
  });
  if (existingCount === 0) {
    await syncHistoricalTelemetryEvents();
  }

  // Fetch raw events with Gate and Scope Group associations
  const rawEvents = await client.lCGateEvent.findMany({
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
 * Fetches filtered operational records and KPIs for date range, multiple scope groups and gates.
 * Supports conditional HTTP 304 revalidation via high-efficiency transactional ETags.
 */
const handleGetRecords = async (req: AuthRequest, res: Response, next: any) => {
  try {
    const access = await resolveUserAccess(req);

    if (!access.isDeveloper && access.accessibleGateIds.length === 0) {
      return res.json({
        dateRange: { startDate: '', endDate: '' },
        filters: { scopeGroupIds: [], gateIds: [], selectedGatesCount: 0, selectedScopeGroupsCount: 0 },
        metrics: {
          totalOperations: 0,
          totalDurationSeconds: 0,
          totalDurationFormatted: '0s',
          avgDurationSeconds: 0,
          avgDurationFormatted: '0s',
          extendedDelaysCount: 0,
          currentlyOpenCount: 0,
          reportingGatesCount: 0,
        },
        records: [],
      });
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

    const statusFilter = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL';
    const shiftFilter = typeof req.query.shift === 'string' ? req.query.shift.toUpperCase() : 'ALL';
    const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
    const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'openedAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc';

    // 1. Construct canonical query string
    const canonicalParams = [
      `scopeGroupIds=${targetScopeGroupIds.slice().sort((a, b) => a - b).join(',')}`,
      `gateIds=${targetGateIds.slice().sort((a, b) => a - b).join(',')}`,
      `startDate=${startDateStr}`,
      `endDate=${endDateStr}`,
      `status=${statusFilter}`,
      `shift=${shiftFilter}`,
      `search=${searchQuery}`,
      `sortBy=${sortBy}`,
      `sortOrder=${sortOrder}`,
    ].join('|');

    // 2. Generate ETag via atomic AppSetting key lookups (Zero LCGateEvent row scans)
    const etag = await generateReportETag(
      req.user?.id || 0,
      targetGateIds,
      access.accessibleScopeIds,
      canonicalParams
    );

    // 3. Conditional Cache Validation (HTTP 304 via RFC 7232 matcher)
    if (isETagMatch(req.headers['if-none-match'], etag)) {
      return res.status(304).set('ETag', etag).end();
    }

    // 4. Cache Miss: Fetch records and compute metrics within atomic RepeatableRead snapshot
    const snapshot = await prisma.$transaction(async (tx) => {
      const data = await fetchFilteredOperationalEvents(req, tx);

      const latestEvent = await tx.lCGateEvent.findFirst({
        where: { gateId: { in: data.targetGateIds } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { updatedAt: true, id: true },
      });

      const latestTombstone = await tx.lCGateEventTombstone.findFirst({
        where: { gateId: { in: data.targetGateIds } },
        orderBy: { id: 'desc' },
        select: { id: true },
      });

      // Compute snapshot ETag using the exact point-in-time state of AppSetting
      const snapshotETag = await generateReportETag(
        req.user?.id || 0,
        data.targetGateIds,
        access.accessibleScopeIds,
        canonicalParams,
        tx
      );

      // Fetch point-in-time gate revisions map for serialized change-log sync
      const gateRevisions = await getLatestGateRevisions(data.targetGateIds, tx);

      // Check whether target gates have unclosed events within the requested date window
      const [sY, sM, sD] = data.startDateStr.split('-').map(Number);
      const [eY, eM, eD] = data.endDateStr.split('-').map(Number);
      const sUtc = new Date(Date.UTC(sY, (sM || 1) - 1, sD || 1, 0, 0, 0, 0));
      const eUtc = new Date(Date.UTC(eY, (eM || 1) - 1, eD || 1, 23, 59, 59, 999));
      const unclosedCount = await tx.lCGateEvent.count({
        where: {
          gateId: { in: data.targetGateIds },
          openedAt: { gte: sUtc, lte: eUtc },
          status: 'OPEN',
        },
      });
      const hasUnclosedEvents = unclosedCount > 0;

      return { data, latestEvent, latestTombstone, snapshotETag, gateRevisions, hasUnclosedEvents };
    }, {
      isolationLevel: 'RepeatableRead',
      timeout: 15000,
      maxWait: 10000,
    });

    const { data, latestEvent, latestTombstone, snapshotETag, gateRevisions, hasUnclosedEvents } = snapshot;

    const cursor = {
      eventCursorTime: latestEvent ? latestEvent.updatedAt.toISOString() : new Date(0).toISOString(),
      eventCursorId: latestEvent ? latestEvent.id : 0,
      tombstoneCursorId: latestTombstone ? latestTombstone.id.toString() : '0',
      gateRevisions,
      hasUnclosedEvents,
      serverTime: new Date().toISOString(),
    };

    res.set('ETag', snapshotETag).json({
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
      cursor,
      metrics: data.metrics,
      records: data.events.map(ev => {
        const matchingGroup: any = null;
        return {
          id: ev.id,
          gateId: ev.gateId,
          lcNumber: ev.gate.lcNumber,
          gateName: ev.gate.name || ev.gate.locationName,
          locationName: ev.gate.locationName,
          zone: ev.gate.zone,
          division: ev.gate.division,
           scopeGroupName: 'Unassigned',
           scopeGroupColor: '#0B3C7A',
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
 * 2b. GET /api/v1/reports/records/changes
 * Incremental Synchronization Endpoint
 * Provides dual-stream delta synchronization:
 *   Stream A: Operational event upserts via composite cursor (eventCursorTime, eventCursorId)
 *   Stream B: Tombstone deletions via monotonic cursor (tombstoneCursorId)
 */
router.get('/records/changes', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const access = await resolveUserAccess(req);
    const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;

    const { targetGateIds } = await resolveFilteredGateIds(
      access,
      req.query.scopeGroupIds as string | undefined,
      gateIdsParam
    );

    if (targetGateIds.length === 0) {
      return res.json({
        requiresFullSync: true,
        resyncReason: 'GATE_REVOKED',
        events: [],
        deletions: [],
        hasMoreEvents: false,
        hasMoreTombstones: false,
        nextEventCursor: { time: new Date(0).toISOString(), id: 0 },
        nextTombstoneCursorId: '0',
        gateRevisions: {},
        authoritativeMetrics: {
          totalOperations: 0,
          totalDurationSeconds: 0,
          avgDurationSeconds: 0,
          extendedDelaysCount: 0,
          currentlyOpenCount: 0,
        },
        serverTime: new Date().toISOString(),
      });
    }

    const limitEvents = Math.min(Math.max(parseInt(req.query.limitEvents as string, 10) || 50, 1), 100);

    // 0. Transactionally Serialized ChangeLog Sync Stream (when gateRevisions is passed)
    const gateRevisionsParam = req.query.gateRevisions;
    let clientGateRevs: Map<number, bigint> | null = null;
    if (typeof gateRevisionsParam === 'string' && gateRevisionsParam.trim()) {
      clientGateRevs = new Map();
      const trimmed = gateRevisionsParam.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          for (const [k, v] of Object.entries(parsed)) {
            const gid = parseInt(k, 10);
            if (!isNaN(gid)) {
              clientGateRevs.set(gid, BigInt(String(v)));
            }
          }
        } catch {}
      } else {
        const parts = trimmed.split(',');
        for (const p of parts) {
          const [k, v] = p.split(':');
          const gid = parseInt(k, 10);
          if (!isNaN(gid) && v && /^\d+$/.test(v.trim())) {
            clientGateRevs.set(gid, BigInt(v.trim()));
          }
        }
      }
    }

    // Check if explicitly requested gate IDs contain revoked gates
    if (gateIdsParam && gateIdsParam !== 'all' && !access.isDeveloper) {
      const parsedIds = gateIdsParam.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (parsedIds.some(id => !access.accessibleGateIds.includes(id))) {
        return res.json({
          requiresFullSync: true,
          resyncReason: 'GATE_REVOKED',
          events: [],
          deletions: [],
          hasMoreEvents: false,
          hasMoreTombstones: false,
          gateRevisions: {},
          authoritativeMetrics: {
            totalOperations: 0,
            totalDurationSeconds: 0,
            avgDurationSeconds: 0,
            extendedDelaysCount: 0,
            currentlyOpenCount: 0,
          },
          serverTime: new Date().toISOString(),
        });
      }
    }

    if (clientGateRevs && clientGateRevs.size > 0) {
      // Security Check: If client cursor contains gates no longer authorized for this user
      if (!access.isDeveloper) {
        for (const gid of clientGateRevs.keys()) {
          if (!access.accessibleGateIds.includes(gid)) {
            return res.json({
              requiresFullSync: true,
              resyncReason: 'GATE_REVOKED',
              events: [],
              deletions: [],
              hasMoreEvents: false,
              hasMoreTombstones: false,
              gateRevisions: {},
              authoritativeMetrics: {
                totalOperations: 0,
                totalDurationSeconds: 0,
                avgDurationSeconds: 0,
                extendedDelaysCount: 0,
                currentlyOpenCount: 0,
              },
              serverTime: new Date().toISOString(),
            });
          }
        }
      }

      const whereConditions = targetGateIds.map(gid => ({
        gateId: gid,
        gateRevision: { gt: clientGateRevs!.get(gid) || 0n },
      }));

      const changeLogRecords = await prisma.lCGateEventChangeLog.findMany({
        where: {
          OR: whereConditions,
        },
        orderBy: [
          { gateRevision: 'asc' },
          { id: 'asc' },
        ],
        take: limitEvents + 1,
      });

      const hasMore = changeLogRecords.length > limitEvents;
      const batch = hasMore ? changeLogRecords.slice(0, limitEvents) : changeLogRecords;

      const neededGateIds = Array.from(new Set(batch.map(b => b.gateId)));
      const gatesData = neededGateIds.length > 0 ? await prisma.lCGate.findMany({
        where: { id: { in: neededGateIds } },
        select: {
          id: true,
          lcNumber: true,
          name: true,
          locationName: true,
          zone: true,
          division: true,
        },
      }) : [];
      const gateMap = new Map(gatesData.map(g => [g.id, g]));

      const events: any[] = [];
      const deletions: number[] = [];
      const nextGateRevisions: Record<string, string> = {};
      for (const gid of targetGateIds) {
        nextGateRevisions[gid.toString()] = (clientGateRevs.get(gid) || 0n).toString();
      }

      for (const rec of batch) {
        const curRev = BigInt(nextGateRevisions[rec.gateId.toString()] || '0');
        if (rec.gateRevision > curRev) {
          nextGateRevisions[rec.gateId.toString()] = rec.gateRevision.toString();
        }

        if (rec.opType === 'DELETE') {
          deletions.push(rec.eventId);
        } else {
          const g = gateMap.get(rec.gateId);
          events.push({
            id: rec.eventId,
            gateId: rec.gateId,
            lcNumber: g?.lcNumber || 'LC-GATE',
            gateName: g?.name || g?.locationName || 'Gate',
            locationName: g?.locationName || 'Location',
            zone: g?.zone || 'CR',
            division: g?.division || 'Pune',
            scopeGroupName: 'Unassigned',
            scopeGroupColor: '#0B3C7A',
            openedAt: rec.openedAt ? rec.openedAt.toISOString() : new Date().toISOString(),
            closedAt: rec.closedAt ? rec.closedAt.toISOString() : null,
            durationSeconds: rec.durationSeconds,
            durationFormatted: rec.durationSeconds ? formatDurationHuman(rec.durationSeconds) : 'Ongoing (Open)',
            status: rec.status,
            openedBy: rec.openedBy,
            closedBy: rec.closedBy,
            trainNumber: rec.trainNumber,
            remarks: rec.remarks,
          });
        }
      }

      const authoritativeMetrics = await calculateAuthoritativeMetrics(
        targetGateIds,
        req.query.startDate as string,
        req.query.endDate as string,
        typeof req.query.shift === 'string' ? req.query.shift.toUpperCase() : 'ALL',
        typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL'
      );

      // Check whether target gates still have any unclosed events in the date range
      const [chSY, chSM, chSD] = ((req.query.startDate as string) || '').split('-').map(Number);
      const [chEY, chEM, chED] = ((req.query.endDate as string) || '').split('-').map(Number);
      const chSUtc = chSY ? new Date(Date.UTC(chSY, (chSM || 1) - 1, chSD || 1, 0, 0, 0, 0)) : new Date(0);
      const chEUtc = chEY ? new Date(Date.UTC(chEY, (chEM || 1) - 1, chED || 1, 23, 59, 59, 999)) : new Date();
      const unclosedInWindow = await prisma.lCGateEvent.count({
        where: {
          gateId: { in: targetGateIds },
          openedAt: { gte: chSUtc, lte: chEUtc },
          status: 'OPEN',
        },
      });
      const hasUnclosedEvents = unclosedInWindow > 0;

      return res.json({
        requiresFullSync: false,
        events,
        deletions,
        hasMoreEvents: hasMore,
        hasMoreTombstones: false,
        gateRevisions: nextGateRevisions,
        hasUnclosedEvents,
        authoritativeMetrics,
        serverTime: new Date().toISOString(),
      });
    }

    // 1. Parse Event Cursor: (time, id)
    let eventCursorTime = new Date(0);
    if (typeof req.query.eventCursorTime === 'string' && req.query.eventCursorTime) {
      const parsed = Date.parse(req.query.eventCursorTime);
      if (!isNaN(parsed)) eventCursorTime = new Date(parsed);
    }
    const eventCursorId = parseInt(req.query.eventCursorId as string, 10) || 0;

    // Transaction commit safety buffer: caller-configurable lookback window (up to 300s)
    // When specified via ?overlapMs=..., allows clients to look back across concurrent in-flight transactions.
    const overlapMsParam = typeof req.query.overlapMs === 'string' ? parseInt(req.query.overlapMs, 10) : 0;
    const overlapMs = Math.max(0, Math.min(isNaN(overlapMsParam) ? 0 : overlapMsParam, 300000));
    const effectiveEventCursorTime = (eventCursorTime.getTime() > 0 && overlapMs > 0)
      ? new Date(Math.max(0, eventCursorTime.getTime() - overlapMs))
      : eventCursorTime;

    // 2. Parse Tombstone Cursor: BigInt (validate string input)
    let tombstoneCursorId = 0n;
    if (typeof req.query.tombstoneCursorId === 'string' && req.query.tombstoneCursorId) {
      const sanitized = req.query.tombstoneCursorId.trim();
      if (/^\d+$/.test(sanitized)) {
        try {
          tombstoneCursorId = BigInt(sanitized);
        } catch {
          tombstoneCursorId = 0n;
        }
      }
    }

    // 3. Limits
    const limitTombstones = Math.min(Math.max(parseInt(req.query.limitTombstones as string, 10) || 100, 1), 200);

    // 4. Tombstone Expiration Watermark Check (including empty tombstone table after purge)
    const purgedSetting = await prisma.appSetting.findUnique({
      where: { key: 'TOMBSTONE_PURGED_WATERMARK' },
      select: { value: true },
    });
    const purgedWatermarkId = purgedSetting && /^\d+$/.test(purgedSetting.value) ? BigInt(purgedSetting.value) : 0n;

    const oldestTombstone = await prisma.lCGateEventTombstone.findFirst({
      where: { gateId: { in: targetGateIds } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    const effectiveOldestWatermark = oldestTombstone
      ? oldestTombstone.id
      : (purgedWatermarkId > 0n ? purgedWatermarkId : null);

    if (effectiveOldestWatermark && tombstoneCursorId > 0n && tombstoneCursorId < effectiveOldestWatermark) {
      return res.json({
        requiresFullSync: true,
        resyncReason: 'TOMBSTONE_CURSOR_EXPIRED',
        events: [],
        deletions: [],
        hasMoreEvents: false,
        hasMoreTombstones: false,
        nextEventCursor: { time: eventCursorTime.toISOString(), id: eventCursorId },
        nextTombstoneCursorId: effectiveOldestWatermark.toString(),
        authoritativeMetrics: await calculateAuthoritativeMetrics(
          targetGateIds,
          req.query.startDate as string,
          req.query.endDate as string,
          typeof req.query.shift === 'string' ? req.query.shift.toUpperCase() : 'ALL',
          typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL'
        ),
        serverTime: new Date().toISOString(),
      });
    }

    // 5. Query Stream A: Events (updatedAt ASC, id ASC)
    const rawEvents = await prisma.lCGateEvent.findMany({
      where: {
        gateId: { in: targetGateIds },
        OR: [
          { updatedAt: { gt: effectiveEventCursorTime } },
          { updatedAt: effectiveEventCursorTime, id: { gt: effectiveEventCursorTime.getTime() === eventCursorTime.getTime() ? eventCursorId : 0 } },
        ],
      },
      include: {
        gate: {
          select: {
            id: true,
            lcNumber: true,
            locationName: true,
            name: true,
            zone: true,
            division: true,
          },
        },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limitEvents + 1,
    });

    const hasMoreEvents = rawEvents.length > limitEvents;
    const eventsBatch = hasMoreEvents ? rawEvents.slice(0, limitEvents) : rawEvents;

    const lastEvent = eventsBatch[eventsBatch.length - 1];
    let nextEventCursor = { time: eventCursorTime.toISOString(), id: eventCursorId };

    if (lastEvent) {
      if (lastEvent.updatedAt.getTime() > eventCursorTime.getTime()) {
        nextEventCursor = { time: lastEvent.updatedAt.toISOString(), id: lastEvent.id };
      } else if (lastEvent.updatedAt.getTime() === eventCursorTime.getTime()) {
        nextEventCursor = { time: lastEvent.updatedAt.toISOString(), id: Math.max(lastEvent.id, eventCursorId) };
      } else {
        // Event lies in overlap buffer window: preserve current cursor forward watermark
        nextEventCursor = { time: eventCursorTime.toISOString(), id: eventCursorId };
      }
    }

    const formattedEvents = eventsBatch.map((ev) => ({
      id: ev.id,
      gateId: ev.gateId,
      lcNumber: ev.gate.lcNumber,
      gateName: ev.gate.name || ev.gate.locationName,
      locationName: ev.gate.locationName,
      zone: ev.gate.zone,
      division: ev.gate.division,
      scopeGroupName: 'Unassigned',
      scopeGroupColor: '#0B3C7A',
      openedAt: ev.openedAt.toISOString(),
      closedAt: ev.closedAt ? ev.closedAt.toISOString() : null,
      durationSeconds: ev.durationSeconds,
      durationFormatted: ev.durationSeconds ? formatDurationHuman(ev.durationSeconds) : 'Ongoing (Open)',
      status: ev.status,
      openedBy: ev.openedBy,
      closedBy: ev.closedBy,
      trainNumber: ev.trainNumber,
      remarks: ev.remarks,
    }));

    // 6. Query Stream B: Tombstones (id ASC)
    const rawTombstones = await prisma.lCGateEventTombstone.findMany({
      where: {
        gateId: { in: targetGateIds },
        id: { gt: tombstoneCursorId },
      },
      select: { id: true, eventId: true },
      orderBy: { id: 'asc' },
      take: limitTombstones + 1,
    });

    const hasMoreTombstones = rawTombstones.length > limitTombstones;
    const tombstonesBatch = hasMoreTombstones ? rawTombstones.slice(0, limitTombstones) : rawTombstones;

    const lastTombstone = tombstonesBatch[tombstonesBatch.length - 1];
    const nextTombstoneCursorId = lastTombstone ? lastTombstone.id.toString() : tombstoneCursorId.toString();

    // 7. Authoritative KPI Metrics Snapshot across full database
    const authoritativeMetrics = await calculateAuthoritativeMetrics(
      targetGateIds,
      req.query.startDate as string,
      req.query.endDate as string,
      typeof req.query.shift === 'string' ? req.query.shift.toUpperCase() : 'ALL',
      typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL'
    );

    return res.json({
      requiresFullSync: false,
      events: formattedEvents,
      nextEventCursor,
      hasMoreEvents,
      deletions: tombstonesBatch.map((t) => t.eventId),
      nextTombstoneCursorId,
      hasMoreTombstones,
      authoritativeMetrics,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 3. GET /api/v1/reports/cycle-analytics
 * Returns analytical cycle counts, durations, and daily breakdown per gate
 */
router.get('/cycle-analytics', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const access = await resolveUserAccess(req);
    if (!access.isDeveloper && access.accessibleGateIds.length === 0) {
      return res.json({
        startDate: '',
        endDate: '',
        overall: {
          totalCycles: 0,
          avgClosingSeconds: 0,
          avgClosingFormatted: '—',
          avgOpeningSeconds: 0,
          avgOpeningFormatted: '—',
          totalClosedSeconds: 0,
          totalClosedFormatted: '0s',
          totalOpenSeconds: 0,
          totalOpenFormatted: '0s',
          reportingGatesCount: 0
        },
        gateReports: []
      });
    }

    const scopeGroupIdsParam = (req.query.scopeGroupIds || req.query.scopeGroupId) as string | undefined;
    const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;

    const { targetGateIds, targetScopeGroupIds } = await resolveFilteredGateIds(
      access,
      scopeGroupIdsParam,
      gateIdsParam
    );

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

    const analytics = await getFullCycleAnalytics({
      targetGateIds,
      targetScopeGroupIds,
      startDateStr,
      endDateStr
    });

    res.json(analytics);
  } catch (error) {
    next(error);
  }
});

/**
 * 4. GET /api/v1/reports/export
 * Downloads either Complete Log Report or Cycle Report as Excel (.xlsx), PDF (.pdf), or RFC-4180 CSV
 */

/**
 * GET /api/v1/reports/count
 * Returns operations count aggregated by Zone, Division, Station, and individual LC Gate
 */
router.get('/count', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const access = await resolveUserAccess(req);
    const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;
    const { targetGateIds } = await resolveFilteredGateIds(access, undefined, gateIdsParam);

    const today = new Date();
    const defaultEnd = today.toISOString().split('T')[0];
    const defaultStartObj = new Date(today);
    defaultStartObj.setDate(today.getDate() - 7);
    const defaultStart = defaultStartObj.toISOString().split('T')[0];

    const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate ? req.query.startDate : defaultStart;
    const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate ? req.query.endDate : defaultEnd;

    const data = await getCountReportAnalytics({
      targetGateIds,
      startDateStr,
      endDateStr
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/reports/duration
 * Returns duration analysis (open vs closed, averages, extended delays, daily breakdown)
 */
router.get('/duration', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const access = await resolveUserAccess(req);
    const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;
    const { targetGateIds } = await resolveFilteredGateIds(access, undefined, gateIdsParam);

    const today = new Date();
    const defaultEnd = today.toISOString().split('T')[0];
    const defaultStartObj = new Date(today);
    defaultStartObj.setDate(today.getDate() - 7);
    const defaultStart = defaultStartObj.toISOString().split('T')[0];

    const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate ? req.query.startDate : defaultStart;
    const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate ? req.query.endDate : defaultEnd;

    const data = await getDurationReportAnalytics({
      targetGateIds,
      startDateStr,
      endDateStr
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/reports/holistic
 * Management-level consolidated hierarchy combining Count and Duration metrics
 */
router.get('/holistic', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const access = await resolveUserAccess(req);
    const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;
    const { targetGateIds } = await resolveFilteredGateIds(access, undefined, gateIdsParam);

    const today = new Date();
    const defaultEnd = today.toISOString().split('T')[0];
    const defaultStartObj = new Date(today);
    defaultStartObj.setDate(today.getDate() - 7);
    const defaultStart = defaultStartObj.toISOString().split('T')[0];

    const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate ? req.query.startDate : defaultStart;
    const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate ? req.query.endDate : defaultEnd;

    const data = await getHolisticReportAnalytics({
      targetGateIds,
      startDateStr,
      endDateStr
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get('/export', async (req: AuthRequest, res: Response, next: any) => {
  try {
    const reportType = (req.query.reportType as string || 'complete_log').toLowerCase();
    const format = (req.query.format as string || 'xlsx').toLowerCase();
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL';
    const shiftFilter = typeof req.query.shift === 'string' ? req.query.shift.toUpperCase() : 'ALL';

    // ── REPORT TYPE: COUNT REPORT ──
    if (reportType === 'count') {
      const access = await resolveUserAccess(req);
      const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;
      const { targetGateIds } = await resolveFilteredGateIds(access, undefined, gateIdsParam);

      const today = new Date();
      const defaultEnd = today.toISOString().split('T')[0];
      const defaultStartObj = new Date(today);
      defaultStartObj.setDate(today.getDate() - 7);
      const defaultStart = defaultStartObj.toISOString().split('T')[0];

      const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate ? req.query.startDate : defaultStart;
      const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate ? req.query.endDate : defaultEnd;

      const countData = await getCountReportAnalytics({ targetGateIds, startDateStr, endDateStr });
      const filenameBase = `LC_Gate_Count_Report_${startDateStr}_to_${endDateStr}`;

      if (format === 'xlsx' || format === 'excel') {
        return await exportCountExcel(res, countData, { filenameBase });
      } else if (format === 'pdf') {
        return await exportCountPdf(res, countData, { filenameBase });
      } else {
        return exportCountCsv(res, countData, { filenameBase });
      }
    }

    // ── REPORT TYPE: HOLISTIC MANAGEMENT REPORT ──
    if (reportType === 'holistic') {
      const access = await resolveUserAccess(req);
      const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;
      const { targetGateIds } = await resolveFilteredGateIds(access, undefined, gateIdsParam);

      const today = new Date();
      const defaultEnd = today.toISOString().split('T')[0];
      const defaultStartObj = new Date(today);
      defaultStartObj.setDate(today.getDate() - 7);
      const defaultStart = defaultStartObj.toISOString().split('T')[0];

      const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate ? req.query.startDate : defaultStart;
      const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate ? req.query.endDate : defaultEnd;

      const holisticData = await getHolisticReportAnalytics({ targetGateIds, startDateStr, endDateStr });
      const filenameBase = `LC_Gate_Holistic_Management_Report_${startDateStr}_to_${endDateStr}`;

      if (format === 'xlsx' || format === 'excel') {
        return await exportHolisticExcel(res, holisticData, { filenameBase });
      } else if (format === 'pdf') {
        return await exportHolisticPdf(res, holisticData, { filenameBase });
      } else {
        return exportHolisticCsv(res, holisticData, { filenameBase });
      }
    }

    // ── REPORT TYPE: DURATION / CYCLE REPORT ──
    if (reportType === 'duration' || reportType === 'cycle') {
      const access = await resolveUserAccess(req);
      const scopeGroupIdsParam = (req.query.scopeGroupIds || req.query.scopeGroupId) as string | undefined;
      const gateIdsParam = (req.query.gateIds || req.query.gateId) as string | undefined;

      const { targetGateIds, targetScopeGroupIds } = await resolveFilteredGateIds(
        access,
        scopeGroupIdsParam,
        gateIdsParam
      );

      const today = new Date();
      const defaultEnd = today.toISOString().split('T')[0];
      const defaultStartObj = new Date(today);
      defaultStartObj.setDate(today.getDate() - 7);
      const defaultStart = defaultStartObj.toISOString().split('T')[0];

      const startDateStr = typeof req.query.startDate === 'string' && req.query.startDate
        ? req.query.startDate
        : defaultStart;

      const endDateStr = typeof req.query.endDate === 'string' && req.query.endDate
        ? req.query.endDate
        : defaultEnd;

      const cycleData = await getFullCycleAnalytics({
        targetGateIds,
        targetScopeGroupIds,
        startDateStr,
        endDateStr
      });

      const filenameBase = `LC_Gate_Cycle_Report_${startDateStr}_to_${endDateStr}`;

      if (format === 'xlsx' || format === 'excel') {
        return await exportCycleExcel(res, cycleData, { filenameBase });
      } else if (format === 'pdf') {
        return await exportCyclePdf(res, cycleData, { filenameBase });
      } else {
        return exportCycleCsv(res, cycleData, { filenameBase });
      }
    }

    // ── REPORT TYPE 1: COMPLETE LOG REPORT ──
    const data = await fetchFilteredOperationalEvents(req);
    const columnsParam = req.query.columns ? (req.query.columns as string).split(',').map(c => c.trim()) : null;

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

    const filenameBase = `LC_Gate_Complete_Log_${data.startDateStr}_to_${data.endDateStr}`;

    if (format === 'xlsx' || format === 'excel') {
      return await exportCompleteLogExcel(res, data as any, activeColumns, { shiftFilter, statusFilter, filenameBase });
    } else if (format === 'pdf') {
      return await exportCompleteLogPdf(res, data as any, activeColumns, { shiftFilter, statusFilter, filenameBase });
    } else {
      return exportCompleteLogCsv(res, data as any, activeColumns, { filenameBase });
    }
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

    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.lCGateEvent.create({
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
      await recordEventChangeInTx(tx, created, 'INSERT');
      return created;
    });

    res.status(201).json(event);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/reports/events/:id
 * Administrative operational event correction
 */
router.put('/events/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid event ID' });

    const existing = await prisma.lCGateEvent.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Event not found' });

    const { status, closedAt, openedAt, remarks, trainNumber } = req.body;

    const updatedEvent = await prisma.$transaction(async (tx) => {
      const newOpened = openedAt ? new Date(openedAt) : existing.openedAt;
      const newClosed = closedAt ? new Date(closedAt) : existing.closedAt;
      let durationSeconds = existing.durationSeconds;
      if (newClosed) {
        durationSeconds = Math.max(0, Math.round((newClosed.getTime() - newOpened.getTime()) / 1000));
      }

      const updated = await tx.lCGateEvent.update({
        where: { id },
        data: {
          ...(status && { status: durationSeconds && durationSeconds > 900 ? 'EXTENDED_DELAY' : status }),
          ...(openedAt && { openedAt: newOpened }),
          ...(closedAt !== undefined && { closedAt: newClosed }),
          durationSeconds,
          ...(remarks !== undefined && { remarks }),
          ...(trainNumber !== undefined && { trainNumber }),
        },
      });

      await recordEventChangeInTx(tx, updated, 'UPDATE');
      return updated;
    });

    res.json(updatedEvent);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/reports/events/:id
 * Single operational event deletion with tombstone logging & revision bump
 */
router.delete('/events/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid event ID' });

    await deleteOperationalEvent(id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/reports/events/batch-delete
 * Bulk operational event deletion with tombstone logging & revision bump
 */
router.post('/events/batch-delete', async (req: AuthRequest, res, next) => {
  try {
    const { eventIds } = req.body;
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ error: 'eventIds array required' });
    }

    const ids = eventIds.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
    const deletedCount = await deleteOperationalEvents(ids);
    res.json({ message: 'Operational events deleted successfully', count: deletedCount });
  } catch (error) {
    next(error);
  }
});

/**
 * 5. POST /api/v1/reports/sync-telemetry
 * Explicitly triggers synchronizing historical telemetry transitions into LCGateEvent
 */
router.post('/sync-telemetry', async (req: AuthRequest, res, next) => {
  try {
    const result = await syncHistoricalTelemetryEvents();
    res.json({ message: 'Telemetry events synced successfully', ...result });
  } catch (error) {
    next(error);
  }
});

export default router;
