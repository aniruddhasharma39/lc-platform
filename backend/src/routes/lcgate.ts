import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { buildUserGateWhereClause, isDeveloperUser, verifyGateAccess } from '../lib/railwayHierarchy';
import {
  authenticate,
  ensureGateAccess,
  ensureJurisdictionForAssetCreation,
  requireAnyModule,
  requireModule,
} from '../middleware/auth';
import { formatLastClosedIST, getISTDateString, getISTUtcDateBounds } from '../lib/timeUtils';
import { RAILWAY_DATA, RAILWAY_ZONES, RAILWAY_STATIONS, divisionsForZone, stationsForDivision, findZoneForDivision } from '../lib/railwayData';

import { publishMqttMessage } from '../lib/iotClient';
import { broadcastGateTelemetry, getGateTelemetryPayload } from '../lib/telemetryWs';
import { bumpDirectoryRevision, getDirectoryRevisionToken } from '../lib/revisionManager';
import { bumpReportRevisionInTx, recordEventChangeInTx } from '../lib/reportRevisionManager';
import { clusterCacheManager } from '../lib/clusterCacheManager';
import { v2 as cloudinary } from 'cloudinary';
import { deleteEvidenceFile } from './evidence';
import {
  GATE_ONLINE_CUTOFF_MS,
  cleanupDetachedThingEventsInTx,
  hydrateGateMasters,
  isGenuineTelemetryPacket,
  parseBarrierStateFromPayload,
  resolveGateStateFromThings,
} from '../lib/thingState';
// @ts-ignore
import { Jimp, loadFont } from 'jimp';
// @ts-ignore
import { SANS_16_WHITE, SANS_16_BLACK } from 'jimp/fonts';

const router = Router();

/**
 * Standard ETag matching helper compliant with RFC 7232
 * Handles weak tags (W/), quotes, comma-separated lists, and wildcard (*)
 */
function matchesETag(headerValue: string | undefined, expectedEtag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === '*') return true;
  const cleanExpected = expectedEtag.replace(/^W\//, '').replace(/"/g, '').trim();
  const tags = trimmed.split(',').map((t) => t.replace(/^W\//, '').replace(/"/g, '').trim());
  return tags.includes(cleanExpected);
}

const createGateSchema = z.object({
  name: z.string().nullable().optional(),
  lcNumberDigits: z.string().optional(),
  lcNumber: z.string().optional(),
  deviceId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
  locationName: z.string().min(1),
  zone: z.string().min(1),
  division: z.string().min(1),
  stationId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().nullable().optional()
  ),
  stationCode: z.string().nullable().optional(),
  stationName: z.string().nullable().optional(),
  latitude: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().nullable().optional()
  ),
  longitude: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().nullable().optional()
  ),
});

const updateGateSchema = z.object({
  name: z.string().nullable().optional(),
  lcNumberDigits: z.string().optional(),
  lcNumber: z.string().optional(),
  locationName: z.string().min(1).optional(),
  zone: z.string().optional(),
  division: z.string().optional(),
  stationId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().nullable().optional()
  ),
  stationCode: z.string().nullable().optional(),
  stationName: z.string().nullable().optional(),
  latitude: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().nullable().optional()
  ),
  longitude: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().nullable().optional()
  ),
});

// Zone/Division reference data (shared source of truth for web + mobile)
// Static railway division topology versioned by REFERENCE_DATA_ETAG
const REFERENCE_DATA_ETAG = 'W/"railway-ref-v1"';

router.get('/reference-data', authenticate, async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.setHeader('ETag', REFERENCE_DATA_ETAG);
  res.setHeader('Vary', 'Accept-Encoding, If-None-Match');

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && matchesETag(ifNoneMatch, REFERENCE_DATA_ETAG)) {
    return res.status(304).end();
  }

  res.json({
    zones: RAILWAY_ZONES,
    divisionsByZone: RAILWAY_DATA,
    stationsByDivision: RAILWAY_STATIONS,
  });
});

// Divisions for a zone (convenience; case-insensitive)
router.get('/divisions', authenticate, async (req, res) => {
  const zone = typeof req.query.zone === 'string' ? req.query.zone : '';
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.json({ zone, divisions: divisionsForZone(zone) });
});

// Stations for a division and/or zone
router.get('/stations', authenticate, async (req, res, next) => {
  try {
    const division = typeof req.query.division === 'string' ? req.query.division.trim() : undefined;
    const zone = typeof req.query.zone === 'string' ? req.query.zone.trim() : undefined;

    let where: any = {};
    if (division) where.division = { equals: division, mode: 'insensitive' };
    if (zone) where.zone = { equals: zone, mode: 'insensitive' };

    const dbStations = await prisma.station.findMany({
      where,
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, division: true, zone: true }
    });

    if (dbStations.length > 0) {
      return res.json(dbStations);
    }

    const fallback = stationsForDivision(division).map((s, idx) => ({
      id: idx + 1,
      code: s.code,
      name: s.name,
      division: division || 'Pune',
      zone: zone || 'Central Railway',
    }));
    res.json(fallback);
  } catch (err) {
    next(err);
  }
});

const createStationSchema = z.object({
  name: z.string().min(1, 'Station name is required'),
  code: z.string().min(1, 'Station code is required'),
  division: z.string().min(1, 'Division is required'),
  zone: z.string().optional(),
});

// Dynamic/manual Station creation with deduplication
router.post('/stations', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const data = createStationSchema.parse(req.body);
    const cleanCode = data.code.trim().toUpperCase();
    const cleanName = data.name.trim();
    const cleanDiv = data.division.trim();
    const resolvedZone = (data.zone || findZoneForDivision(cleanDiv) || '').trim();
    if (!resolvedZone) {
      return res.status(400).json({ error: 'Railway Zone is required or could not be resolved for this division.' });
    }
    const cleanZone = resolvedZone;
    if (!(await ensureJurisdictionForAssetCreation(req, res, { zone: cleanZone, division: cleanDiv }))) return;

    // Deduplication check: case-insensitive check by code
    let station = await prisma.station.findUnique({
      where: { code: cleanCode }
    });

    if (station) {
      return res.json(station);
    }

    station = await prisma.station.create({
      data: {
        code: cleanCode,
        name: cleanName,
        division: cleanDiv,
        zone: cleanZone,
      }
    });

    res.status(201).json(station);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const existing = await prisma.station.findUnique({
        where: { code: req.body.code?.trim().toUpperCase() }
      });
      if (existing) return res.json(existing);
    }
    next(error);
  }
});

// Helper to format KPI duration into human-readable string (e.g., "14m 20s", "5m", "45s", or "--")
function formatKpiDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds <= 0) {
    return '--';
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  if (secs === 0) {
    return `${mins}m`;
  }
  return `${mins}m ${secs}s`;
}

// GET /dashboard-summary - Home screen KPIs, gate cycle stats & cluster map coordinates
router.get('/dashboard-summary', authenticate, async (req: any, res, next) => {
  try {
    const isDeveloper = isDeveloperUser(req.user);

    // Role-based access (no scope groups)
    const directorySettings = await prisma.appSetting.findMany({
      where: { key: { startsWith: 'DIRECTORY_' } },
      select: { key: true, value: true }
    });

    let whereClause: any = {};

    if (!isDeveloper) {
      const designationClause = await buildUserGateWhereClause(req.user, prisma);
      if (designationClause.id === -1) {
        return res.json({
          totalDevices: 0,
          totalClusters: 0,
          totalConfiguredClusters: 0,
          totalUnconfiguredGates: 0,
          totalAllGates: 0,
          totalCyclesToday: 0,
          totalOpenGates: 0,
          totalClosedGates: 0,
          gates: []
        });
      }
      whereClause = { ...whereClause, ...designationClause };
    }


    // Start of today in IST (00:00:00.000+05:30)
    const todayIst = getISTDateString(new Date());
    const { startUtc: startOfTodayIst } = getISTUtcDateBounds(todayIst, todayIst);

    const rawGates = await prisma.lCGate.findMany({
      where: whereClause,
      orderBy: { lcNumber: 'asc' },
      include: {
        station: { select: { id: true, code: true, name: true, division: true, zone: true } },
        deviceRegistries: true,
        masters: {
          orderBy: { masterSequence: 'asc' },
          include: {
            childDevices: {
              orderBy: { deviceSequence: 'asc' },
              include: { evidences: true },
            },
            deviceRegistry: true,
            evidences: true,
          }
        }
      }
    });

    const gates = rawGates.map(hydrateGateMasters);
    const nowMs = Date.now();

    let totalCyclesToday = 0;
    let totalOpenGates = 0;
    let totalClosedGates = 0;
    let totalNoTelemetryGates = 0;

    // Exclude ALL unconfigured gates from KPI totals & Assigned Gate Cycles (single source of truth = linked AWS IoT Things)
    const configuredGateMeta = gates
      .map((gate) => ({ gate, resolved: resolveGateStateFromThings(gate, nowMs) }))
      .filter((entry) => entry.resolved.isConfigured);

    const configuredGateIds = configuredGateMeta.map((e) => e.gate.id);
    const allActiveMasterIds = Array.from(new Set(
      configuredGateMeta.flatMap((e) => e.gate.masters.map((m: any) => m.id).filter(Boolean))
    ));
    const allActiveThingNames = Array.from(new Set(
      configuredGateMeta.flatMap((e) => e.resolved.linkedThings.map((t: any) => t.thingName).filter(Boolean))
    ));

    // Fetch 100% of Today's IST events scoped to active hardware Things/Masters (zero take:50 truncation)
    const todayHwFilters: any[] = [];
    if (allActiveMasterIds.length > 0) todayHwFilters.push({ masterId: { in: allActiveMasterIds } });
    if (allActiveThingNames.length > 0) todayHwFilters.push({ thingName: { in: allActiveThingNames } });

    const allTodayRawEvents = (configuredGateIds.length > 0 && todayHwFilters.length > 0)
      ? await prisma.lCGateEvent.findMany({
          where: {
            gateId: { in: configuredGateIds },
            openedAt: { gte: startOfTodayIst },
            OR: todayHwFilters,
          },
          orderBy: { openedAt: 'desc' },
        })
      : [];

    const todayEventsByGate = new Map<number, any[]>();
    for (const ev of allTodayRawEvents) {
      if (!todayEventsByGate.has(ev.gateId)) todayEventsByGate.set(ev.gateId, []);
      todayEventsByGate.get(ev.gateId)!.push(ev);
    }

    // For gates with <2 closed cycles today (or needing lastClosedEvent / inter-cycle fallback),
    // fetch up to 50 prior historical events scoped strictly to that gate's active Master/Thing IDs
    const historicalEventsByGate = new Map<number, any[]>();
    await Promise.all(
      configuredGateMeta.map(async ({ gate, resolved }) => {
        const activeMasterIds = new Set<number>(gate.masters.map((m: any) => m.id));
        const activeThingNames = new Set<string>(resolved.linkedThings.map((t: any) => t.thingName));
        const gateTodayScoped = (todayEventsByGate.get(gate.id) || []).filter(
          (e: any) => (e.masterId && activeMasterIds.has(e.masterId)) || (e.thingName && activeThingNames.has(e.thingName))
        );
        const closedTodayCount = gateTodayScoped.filter((e: any) => e.closedAt !== null).length;
        if (closedTodayCount >= 2) {
          return;
        }
        const gateHwFilters: any[] = [];
        if (activeMasterIds.size > 0) gateHwFilters.push({ masterId: { in: Array.from(activeMasterIds) } });
        if (activeThingNames.size > 0) gateHwFilters.push({ thingName: { in: Array.from(activeThingNames) } });
        if (gateHwFilters.length === 0) return;

        const hist = await prisma.lCGateEvent.findMany({
          where: {
            gateId: gate.id,
            openedAt: { lt: startOfTodayIst },
            OR: gateHwFilters,
          },
          orderBy: { openedAt: 'desc' },
          take: 50,
        });
        historicalEventsByGate.set(gate.id, hist);
      })
    );

    const configuredGateEntries: any[] = [];

    for (const { gate, resolved } of configuredGateMeta) {
      const activeMasterIds = new Set<number>(gate.masters.map((m: any) => m.id));
      const activeThingNames = new Set<string>(resolved.linkedThings.map((t: any) => t.thingName));
      const combinedEvents = [
        ...(todayEventsByGate.get(gate.id) || []),
        ...(historicalEventsByGate.get(gate.id) || []),
      ];
      const scopedEvents = combinedEvents
        .filter((e: any) => {
          if (e.masterId && activeMasterIds.has(e.masterId)) return true;
          if (e.thingName && activeThingNames.has(e.thingName)) return true;
          return false;
        })
        .sort((a: any, b: any) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());

      const isSolar = gate.masters.some((m: any) => m.powerSource === 'SOLAR');
      const primaryMaster = gate.masters[0]?.serialNumber || null;
      const slavesCount = gate.masters.reduce((acc: number, m: any) => acc + (m.childDevices?.length || 0), 0);

      // Compute cycles for today strictly from linked hardware Thing events in IST
      const todayEvents = scopedEvents.filter((e: any) => {
        const opTime = new Date(e.openedAt).getTime();
        return opTime >= startOfTodayIst.getTime();
      });

      const todayCyclesCount = todayEvents.length;
      totalCyclesToday += todayCyclesCount;

      const todayCompleted = todayEvents.filter((e: any) => e.closedAt && e.durationSeconds && e.durationSeconds > 0);
      const allCompleted = scopedEvents.filter((e: any) => e.closedAt && e.durationSeconds && e.durationSeconds > 0);
      const targetOpenEvents = todayCompleted.length > 0 ? todayCompleted : allCompleted;

      let avgOpenSeconds: number | null = null;
      if (targetOpenEvents.length > 0) {
        const sumSec = targetOpenEvents.reduce((acc: number, ev: any) => acc + (ev.durationSeconds || 0), 0);
        avgOpenSeconds = Math.round(sumSec / targetOpenEvents.length);
      }
      const avgOpenFormatted = formatKpiDuration(avgOpenSeconds);

      const chronologicalEvents = [...scopedEvents]
        .filter((e: any) => e.openedAt)
        .sort((a: any, b: any) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());

      let totalClosedSec = 0;
      let closedIntervalCount = 0;

      for (let i = 0; i < chronologicalEvents.length - 1; i++) {
        const curEvent = chronologicalEvents[i];
        const nextEvent = chronologicalEvents[i + 1];

        if (curEvent.closedAt && nextEvent.openedAt) {
          const closedDiffSec = Math.round(
            (new Date(nextEvent.openedAt).getTime() - new Date(curEvent.closedAt).getTime()) / 1000
          );
          if (closedDiffSec >= 30 && closedDiffSec <= 43200) {
            totalClosedSec += closedDiffSec;
            closedIntervalCount++;
          }
        }
      }

      let avgClosedSeconds: number | null = null;
      if (closedIntervalCount > 0) {
        avgClosedSeconds = Math.round(totalClosedSec / closedIntervalCount);
      }
      const avgClosedFormatted = formatKpiDuration(avgClosedSeconds);

      const lastClosedEvent = scopedEvents.find((e: any) => e.closedAt !== null);
      let lastClosedAt: string | null = null;
      let lastClosedFormatted: string = 'No recorded closure';

      if (lastClosedEvent && lastClosedEvent.closedAt) {
        lastClosedAt = lastClosedEvent.closedAt.toISOString();
        lastClosedFormatted = formatLastClosedIST(new Date(lastClosedEvent.closedAt), new Date());
      }

      const status = resolved.status; // 'OPEN' | 'CLOSED' | 'NO_TELEMETRY'
      if (status === 'OPEN') {
        totalOpenGates++;
      } else if (status === 'CLOSED') {
        totalClosedGates++;
      } else if (status === 'NO_TELEMETRY') {
        totalNoTelemetryGates++;
      }

      configuredGateEntries.push({
        id: gate.id,
        lcNumber: gate.lcNumber,
        name: gate.name || gate.locationName,
        locationName: gate.locationName,
        zone: gate.zone || null,
        division: gate.division || null,
        latitude: gate.latitude,
        longitude: gate.longitude,
        powerSource: isSolar ? 'SOLAR' : 'DIRECT',
        status,
        currentStatus: status,
        isConfigured: true,
        hasMaster: true,
        isOnline: resolved.isOnline,
        deviceStatus: resolved.deviceStatus,
        lastSeenAt: resolved.lastSeenAt,
        todayCycles: todayCyclesCount,
        totalCycles: scopedEvents.length,
        avgOpenSeconds,
        avgOpenFormatted,
        avgClosedSeconds,
        avgClosedFormatted,
        lastClosedAt,
        lastClosedFormatted,
        masterSerialNumber: primaryMaster,
        mastersCount: gate.masters.length,
        hardwareMastersCount: resolved.hardwareMastersCount,
        onlineMastersCount: resolved.onlineMastersCount,
        slavesCount,
        stationId: gate.stationId || null,
        stationCode: (gate as any).station?.code || null,
        stationName: (gate as any).station?.name || null,
        scopeGroupId: null,
        scopeGroupName: null,
        scopeGroupColor: null,
      });
    }

    const totalAllGates = gates.length;
    const totalConfiguredClusters = configuredGateEntries.length;
    const totalUnconfiguredGates = Math.max(0, totalAllGates - totalConfiguredClusters);

    const gatesWithAvgOpen = configuredGateEntries.filter(g => g.avgOpenSeconds !== null && g.avgOpenSeconds > 0);
    const globalAvgOpenSec = gatesWithAvgOpen.length > 0
      ? Math.round(gatesWithAvgOpen.reduce((sum, g) => sum + g.avgOpenSeconds!, 0) / gatesWithAvgOpen.length)
      : null;
    const globalAvgOpenFormatted = formatKpiDuration(globalAvgOpenSec);

    const gatesWithAvgClosed = configuredGateEntries.filter(g => g.avgClosedSeconds !== null && g.avgClosedSeconds > 0);
    const globalAvgClosedSec = gatesWithAvgClosed.length > 0
      ? Math.round(gatesWithAvgClosed.reduce((sum, g) => sum + g.avgClosedSeconds!, 0) / gatesWithAvgClosed.length)
      : null;
    const globalAvgClosedFormatted = formatKpiDuration(globalAvgClosedSec);

    const responsePayload = {
      totalDevices: totalConfiguredClusters,
      totalClusters: totalConfiguredClusters,
      totalConfiguredClusters,
      totalConfiguredGates: totalConfiguredClusters,
      totalUnconfiguredGates,
      totalAllGates,
      totalCyclesToday,
      totalOpenGates,
      totalClosedGates,
      totalNoTelemetryGates,
      avgOpenSeconds: globalAvgOpenSec,
      avgOpenFormatted: globalAvgOpenFormatted,
      avgClosedSeconds: globalAvgClosedSec,
      avgClosedFormatted: globalAvgClosedFormatted,
      gates: configuredGateEntries,
      lastSyncedAt: new Date().toISOString(),
    };

    // Calculate ETag based on payload contents for conditional HTTP synchronization (304 Not Modified)
    const contentHash = crypto
      .createHash('md5')
      .update(JSON.stringify({
        totalDevices: responsePayload.totalDevices,
        totalConfiguredGates: responsePayload.totalConfiguredGates,
        totalUnconfiguredGates: responsePayload.totalUnconfiguredGates,
        totalAllGates: responsePayload.totalAllGates,
        totalCyclesToday: responsePayload.totalCyclesToday,
        totalOpenGates: responsePayload.totalOpenGates,
        totalClosedGates: responsePayload.totalClosedGates,
        totalNoTelemetryGates: responsePayload.totalNoTelemetryGates,
        avgOpenFormatted: responsePayload.avgOpenFormatted,
        avgClosedFormatted: responsePayload.avgClosedFormatted,
        gateSignatures: configuredGateEntries.map((g: any) => `${g.id}:${g.status}:${g.todayCycles}:${g.totalCycles}:${g.avgOpenFormatted}:${g.avgClosedFormatted}:${g.lastClosedAt}`),
      }))
      .digest('hex');

    const etag = `W/"${contentHash}"`;
    res.setHeader('ETag', etag);

    const clientIfNoneMatch = Array.isArray(req.headers['if-none-match'])
      ? req.headers['if-none-match'][0]
      : req.headers['if-none-match'];
    if (clientIfNoneMatch && matchesETag(clientIfNoneMatch, etag)) {
      return res.status(304).end();
    }

    res.json(responsePayload);
  } catch (error) {
    next(error);
  }
});


// Create a new LC Gate (Clean railway asset creation decoupled from AWS IoT provisioning)
router.post('/', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const data = createGateSchema.parse(req.body);
    if (!(await ensureJurisdictionForAssetCreation(req, res, { zone: data.zone, division: data.division }))) return;

    const rawLc = (data.lcNumber || data.lcNumberDigits || '').trim();
    if (!rawLc) {
      return res.status(400).json({ error: 'LC Number is mandatory' });
    }
    const cleanLcNumber = rawLc.toUpperCase().startsWith('LC-')
      ? rawLc.toUpperCase()
      : `LC-${rawLc.toUpperCase()}`;

    // Case-insensitive check for existing gate
    const existing = await prisma.lCGate.findFirst({
      where: {
        lcNumber: { equals: cleanLcNumber, mode: 'insensitive' }
      }
    });
    if (existing) {
      return res.status(400).json({ error: `Gate with LC Number "${cleanLcNumber}" already exists` });
    }

    const gateName = (data.name && data.name.trim()) 
      ? data.name.trim() 
      : (data.locationName ? data.locationName.trim() : cleanLcNumber);

    let resolvedStationId: number | null = data.stationId || null;
    if (!resolvedStationId && (data.stationCode || data.stationName)) {
      const code = (data.stationCode || data.stationName || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
      if (code) {
        let st = await prisma.station.findUnique({ where: { code } });
        if (!st && data.stationName) {
          st = await prisma.station.create({
            data: {
              code,
              name: data.stationName.trim(),
              division: data.division.trim(),
              zone: data.zone.trim(),
            }
          }).catch(() => null);
        }
        if (st) resolvedStationId = st.id;
      }
    }

    const gate = await prisma.$transaction(async (tx) => {
      const created = await tx.lCGate.create({
        data: {
          name: gateName,
          lcNumber: cleanLcNumber,
          locationName: data.locationName.trim(),
          zone: data.zone.trim(),
          division: data.division.trim(),
          stationId: resolvedStationId,
          latitude: data.latitude,
          longitude: data.longitude,
        },
        include: {
          station: true,
          masters: true,
          deviceRegistries: true,
        }
      });

      await bumpDirectoryRevision([], true, tx);
      clusterCacheManager.clear();

      return created;
    }, { maxWait: 5000, timeout: 20000 });

    res.status(201).json(gate);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'An LC Gate with this number already exists in the system.' });
    }
    next(error);
  }
});

// PUT /:id - Edit and update an existing LC Gate
router.put('/:id', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });
    if (!(await ensureGateAccess(req, res, id))) return;

    const existing = await prisma.lCGate.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'LC Gate not found' });

    const data = updateGateSchema.parse(req.body);

    let cleanLcNumber = existing.lcNumber;
    const rawLc = (data.lcNumber || data.lcNumberDigits || '').trim();
    if (rawLc) {
      cleanLcNumber = rawLc.toUpperCase().startsWith('LC-')
        ? rawLc.toUpperCase()
        : `LC-${rawLc.toUpperCase()}`;

      if (cleanLcNumber !== existing.lcNumber) {
        const duplicate = await prisma.lCGate.findFirst({
          where: {
            lcNumber: { equals: cleanLcNumber, mode: 'insensitive' },
            id: { not: id }
          }
        });
        if (duplicate) {
          return res.status(400).json({ error: `Gate with LC Number "${cleanLcNumber}" already exists` });
        }
      }
    }

    let resolvedStationId = data.stationId !== undefined ? data.stationId : existing.stationId;
    if (!resolvedStationId && (data.stationCode || data.stationName)) {
      const code = (data.stationCode || data.stationName || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 8);
      if (code) {
        let st = await prisma.station.findUnique({ where: { code } });
        if (!st && data.stationName) {
          const stDiv = (data.division || existing.division || '').trim();
          const stZone = (data.zone || existing.zone || '').trim();
          if (stDiv && stZone) {
            st = await prisma.station.create({
              data: {
                code,
                name: data.stationName.trim(),
                division: stDiv,
                zone: stZone,
              }
            }).catch(() => null);
          }
        }
        if (st) resolvedStationId = st.id;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const gate = await tx.lCGate.update({
        where: { id },
        data: {
          name: data.name !== undefined ? (data.name?.trim() || null) : existing.name,
          lcNumber: cleanLcNumber,
          locationName: data.locationName ? data.locationName.trim() : existing.locationName,
          zone: data.zone || existing.zone,
          division: data.division || existing.division,
          stationId: resolvedStationId,
          latitude: data.latitude !== undefined ? data.latitude : existing.latitude,
          longitude: data.longitude !== undefined ? data.longitude : existing.longitude,
        },
        include: {
          station: true,
          masters: {
            include: { childDevices: true, evidences: true, deviceRegistry: true }
          },
          deviceRegistries: true,
        }
      });

      await bumpDirectoryRevision([], true, tx);

      return hydrateGateMasters(gate);
    }, { maxWait: 5000, timeout: 20000 });

    clusterCacheManager.clear();
    res.json(updated);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'An LC Gate with this number already exists in the system.' });
    }
    next(error);
  }
});

// POST /:id/assign-device - Assign physical AWS IoT device to LC Gate / Master Unit
router.post('/:id/assign-device', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const gateId = parseInt(req.params.id, 10);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });
    if (!(await ensureGateAccess(req, res, gateId))) return;

    const { deviceId, masterId, childDeviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const gate = await prisma.lCGate.findUnique({ where: { id: gateId }, include: { masters: true } });
    if (!gate) return res.status(404).json({ error: 'LC Gate not found' });

    const dev = await prisma.deviceRegistry.findUnique({ where: { id: Number(deviceId) } });
    if (!dev) return res.status(404).json({ error: 'Device not found in registry' });
    if (dev.gateId && dev.gateId !== gateId && !(await ensureGateAccess(req, res, dev.gateId))) return;

    const targetMasterId = masterId ? Number(masterId) : null;
    if (!targetMasterId) {
      return res.status(400).json({ error: 'Explicit masterId is required to bind an AWS IoT Thing (1-to-1).' });
    }
    const targetMasterObj = gate.masters.find(m => m.id === targetMasterId);
    if (!targetMasterObj) {
      return res.status(404).json({ error: 'Selected Master Unit does not belong to this LC Gate.' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      // Clean up any previously bound device & its orphan LCGateEvent rows on this Master Unit
      const prevBound = await tx.deviceRegistry.findMany({
        where: { masterId: targetMasterId, id: { not: dev.id } },
        select: { id: true, thingName: true },
      });
      if (prevBound.length > 0) {
        for (const p of prevBound) {
          await cleanupDetachedThingEventsInTx(tx, {
            gateId: gate.id,
            masterId: targetMasterId,
            thingName: p.thingName,
          });
        }
        await tx.deviceRegistry.updateMany({
          where: { masterId: targetMasterId, id: { not: dev.id } },
          data: { gateId: null, masterId: null, childDeviceId: null },
        });
      }

      // If this Thing was previously assigned to a different gate, clean its old gate's detached events
      if (dev.gateId && dev.gateId !== gate.id) {
        await cleanupDetachedThingEventsInTx(tx, {
          gateId: dev.gateId,
          masterId: dev.masterId,
          thingName: dev.thingName,
        });
      }

      const devUpdated = await tx.deviceRegistry.update({
        where: { id: dev.id },
        data: {
          gateId: gate.id,
          masterId: targetMasterId,
          childDeviceId: childDeviceId ? Number(childDeviceId) : null,
        }
      });
      await syncDeviceHistoryToGate(
        gate.id,
        dev.thingName,
        tx,
        targetMasterId,
        targetMasterObj.serialNumber || null
      );

      await bumpDirectoryRevision([], true, tx);

      return devUpdated;
    }, { maxWait: 5000, timeout: 20000 });

    clusterCacheManager.clear();
    broadcastGateTelemetry(gateId).catch(console.warn);
    if (dev.gateId && dev.gateId !== gateId) {
      broadcastGateTelemetry(dev.gateId).catch(console.warn);
    }

    res.json({ success: true, message: 'Device assigned successfully', device: updated });
  } catch (error) {
    next(error);
  }
});

// POST /:id/unassign-device - Unassign physical AWS IoT device from LC Gate
router.post('/:id/unassign-device', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const gateId = parseInt(req.params.id, 10);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });
    if (!(await ensureGateAccess(req, res, gateId))) return;

    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const dev = await prisma.deviceRegistry.findUnique({ where: { id: Number(deviceId) } });
    if (!dev) return res.status(404).json({ error: 'Device not found in registry' });

    const updated = await prisma.$transaction(async (tx) => {
      // Remove/tombstone operational events tied to the detached Thing/Master on this gate
      await cleanupDetachedThingEventsInTx(tx, {
        gateId,
        masterId: dev.masterId,
        thingName: dev.thingName,
      });

      const devUpdated = await tx.deviceRegistry.update({
        where: { id: dev.id },
        data: {
          gateId: null,
          masterId: null,
          childDeviceId: null,
        }
      });

      await bumpDirectoryRevision([], true, tx);

      return devUpdated;
    }, { maxWait: 5000, timeout: 20000 });

    clusterCacheManager.clear();
    broadcastGateTelemetry(gateId).catch(console.warn);

    res.json({ success: true, message: 'Device unassigned successfully', device: updated });
  } catch (error) {
    next(error);
  }
});

function collectAssignedThingNames(gates: any[]): string[] {
  const names = new Set<string>();
  for (const g of gates) {
    for (const m of g.masters || []) {
      const reg = m.deviceRegistry || (Array.isArray(m.deviceRegistries) ? m.deviceRegistries[0] : null);
      if (reg?.thingName) names.add(reg.thingName);
    }
    for (const d of g.deviceRegistries || []) {
      if (d.masterId !== null && d.thingName) names.add(d.thingName);
    }
  }
  return Array.from(names);
}

function computeGateConnectivity(
  gate: any,
  _latestTeleByThing: Map<string, any>,
  nowMs: number
) {
  const resolved = resolveGateStateFromThings(gate, nowMs);
  return {
    isConfigured: resolved.isConfigured,
    currentStatus: resolved.status,
    hasHardware: resolved.hasHardware,
    isOnline: resolved.isOnline,
    deviceStatus: resolved.hasHardware ? resolved.deviceStatus : null,
    lastSeenAt: resolved.lastSeenAt,
    onlineMastersCount: resolved.onlineMastersCount,
    hardwareMastersCount: resolved.hardwareMastersCount,
  };
}

// GET /status-summary - Dedicated, lightweight real-time connectivity & barrier status for accessible gates
router.get('/status-summary', authenticate, async (req: any, res, next) => {
  try {
    const isDeveloper = isDeveloperUser(req.user);

    let whereClause: any = {};
    if (!isDeveloper) {
      const designationClause = await buildUserGateWhereClause(req.user, prisma);
      if (designationClause.id === -1) {
        return res.json({ verifiedAt: new Date().toISOString(), statuses: [] });
      }
      whereClause = { ...whereClause, ...designationClause };
    }

    const rawGates = await prisma.lCGate.findMany({
      where: whereClause,
      select: {
        id: true,
        lcNumber: true,
        masters: {
          select: {
            id: true,
            serialNumber: true,
            deviceRegistry: {
              select: { id: true, thingName: true, masterId: true, status: true, connectivityStatus: true, barrierState: true, lastSeenAt: true }
            }
          }
        },
        deviceRegistries: {
          select: { id: true, thingName: true, serialNumber: true, lastSeenAt: true, status: true, connectivityStatus: true, barrierState: true, masterId: true }
        }
      }
    });

    const gates = rawGates.map(hydrateGateMasters);
    const nowMs = Date.now();
    const emptyMap = new Map<string, any>();

    const statuses = gates.map(gate => {
      const resolved = resolveGateStateFromThings(gate, nowMs);
      void emptyMap;
      return {
        gateId: gate.id,
        lcNumber: gate.lcNumber,
        isConfigured: resolved.isConfigured,
        currentStatus: resolved.status,
        isOnline: resolved.isOnline,
        deviceStatus: resolved.hasHardware ? resolved.deviceStatus : null,
        lastSeenAt: resolved.lastSeenAt,
        onlineMastersCount: resolved.onlineMastersCount,
        hardwareMastersCount: resolved.hardwareMastersCount,
        hasMaster: gate.masters.length > 0,
        mastersCount: gate.masters.length,
      };
    });

    res.json({
      verifiedAt: new Date().toISOString(),
      statuses,
    });
  } catch (error) {
    next(error);
  }
});

// Get all LC Gates with their masters (strictly scoped to assigned scope groups and child hierarchy)
router.get('/', authenticate, async (req: any, res, next) => {
  try {
    // 1. Consistent Database Read via RepeatableRead Transaction
    // Ensures live user status, server-side role/permissions, user scope assignments,
    // directory revisions, and gate queries represent the identical PostgreSQL database snapshot.
    const snapshot = await prisma.$transaction(
      async (tx) => {
        // Read live user record, role, and module permissions within snapshot
        const currentUser = await tx.user.findUnique({
          where: { id: req.user.id },
          include: {
            role: {
              include: {
                roleModules: {
                  include: { module: true },
                },
              },
            },
          },
        });

        // 1. Authoritative check: User active / deactivated status
        if (!currentUser || currentUser.status !== 'APPROVED') {
          return { isDeactivated: true };
        }

        // 2. Authoritative check: Live role & developer privilege (never relies on stale JWT)
        const liveRoleName = currentUser.role?.name || '';
        const isDeveloper = isDeveloperUser(currentUser);
        const allowedModules = currentUser.role?.roleModules.map((rm: any) => rm.module.slug) || [];

        // 3. Permission check: Developer or explicit cluster module permission
        const hasClusterAccess = isDeveloper || allowedModules.includes('cluster') || allowedModules.includes('lc-gates');
        if (!hasClusterAccess) {
          return { isRoleForbidden: true, liveRoleName };
        }

        // Role-based access (no scope groups)
        let whereClause: any = {};
        let isForbidden = false;
        let isNoScope = false;
        let relevantScopeGroupIds: number[] = [];

        if (!isDeveloper) {
          const designationClause = await buildUserGateWhereClause(req.user, tx as any);
          if (designationClause.id === -1) {
            isNoScope = true;
          } else {
            whereClause = { ...whereClause, ...designationClause };
          }
        }


        // Read all relevant directory revisions within the same snapshot
        const directorySettings = await tx.appSetting.findMany({
          where: { key: { startsWith: 'DIRECTORY_' } },
          select: { key: true, value: true },
        });

        // Derive revision token from this consistent settings snapshot monitoring all relevant scopes
        const revisionToken = await getDirectoryRevisionToken(
          req.user.id,
          relevantScopeGroupIds,
          isDeveloper,
          directorySettings
        );

        return {
          assignedScopeGroupIds: [],
          relevantScopeGroupIds,
          directorySettings,
          revisionToken,
          whereClause,
          isForbidden,
          isNoScope,
          isDeactivated: false,
          isRoleForbidden: false,
          liveRoleName,
          isDeveloper,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5000,
        timeout: 15000,
      }
    );

    if (snapshot.isDeactivated) {
      return res.status(401).json({ error: 'User account is deactivated or not approved' });
    }

    if (snapshot.isRoleForbidden) {
      return res.status(403).json({ error: 'Forbidden: Access to cluster is not permitted for your role' });
    }

    if (snapshot.isForbidden) {
      const paramId = parseInt(req.query.scopeGroupId as string, 10);
      res.setHeader('ETag', `W/"cl-u${req.user.id}-forbidden-${paramId}"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      return res.json([]);
    }

    if (snapshot.isNoScope) {
      res.setHeader('ETag', `W/"cl-u${req.user.id}-no-scope"`);
      res.setHeader('Cache-Control', 'private, no-cache');
      return res.json([]);
    }

    const canonicalParams = {
      userId: req.user.id,
      userRole: snapshot.liveRoleName || 'User',
      directoryRevision: snapshot.revisionToken || '1',
      scopeGroupId: typeof req.query.scopeGroupId === 'string' ? req.query.scopeGroupId : null,
      directOnly: typeof req.query.directOnly === 'string' ? req.query.directOnly : null,
      configuredOnly: req.query.configuredOnly === 'true' ? 'true' : null,
    };

    const cacheKey = clusterCacheManager.generateKey(canonicalParams);
    const clientIfNoneMatch = req.headers['if-none-match'];

    // Check L1 In-Memory Response Cache
    const cached = clusterCacheManager.get<any[]>(cacheKey);
    if (cached) {
      res.setHeader('ETag', cached.etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Vary', 'Authorization, If-None-Match');

      if (clientIfNoneMatch && matchesETag(clientIfNoneMatch, cached.etag)) {
        return res.status(304).end();
      }

      res.setHeader('X-Cluster-Cache', 'HIT');
      return res.json(cached.data);
    }

    const rawGates = await prisma.lCGate.findMany({
      where: snapshot.whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        station: { select: { id: true, code: true, name: true, division: true, zone: true } },
        deviceRegistries: true,
        events: {
          orderBy: { openedAt: 'desc' },
          take: 1
        },
        masters: {
          orderBy: { masterSequence: 'asc' },
          include: {
            childDevices: {
              orderBy: { deviceSequence: 'asc' },
              include: { evidences: true }
            },
            evidences: true,
            deviceRegistry: true
          }
        }
      },
    });

    const gates = rawGates.map(hydrateGateMasters);
    const nowMs = Date.now();
    const ONLINE_CUTOFF_MS = GATE_ONLINE_CUTOFF_MS;

    const enrichedGates = gates.map(gate => {
      const resolved = resolveGateStateFromThings(gate, nowMs);
      return {
        ...gate,
        isConfigured: resolved.isConfigured,
        currentStatus: resolved.status,
        status: resolved.status,
        isOnline: resolved.isOnline,
        deviceStatus: resolved.hasHardware ? resolved.deviceStatus : null,
        lastSeenAt: resolved.lastSeenAt,
        onlineMastersCount: resolved.onlineMastersCount,
        hardwareMastersCount: resolved.hardwareMastersCount,
      };
    });

    // Ensure gate list is strictly unique by ID
    const uniqueGates = Array.from(new Map(enrichedGates.map(g => [g.id, g])).values());
    const responseGates = req.query.configuredOnly === 'true'
      ? uniqueGates.filter((g) => g.isConfigured)
      : uniqueGates;

    // Transition-Aware TTL Calculation:
    // Determine the exact timestamp when the earliest currently-online device crosses 65 minutes
    const onlineExpirations: number[] = [];
    responseGates.forEach(g => {
      if (g.isOnline && g.lastSeenAt) {
        const lastSeenMs = new Date(g.lastSeenAt).getTime();
        onlineExpirations.push(lastSeenMs + ONLINE_CUTOFF_MS);
      }
    });

    // Default max TTL is 15 minutes if no devices are online or all are fresh
    let ttlMs = 15 * 60 * 1000;
    if (onlineExpirations.length > 0) {
      const earliestTransitionMs = Math.min(...onlineExpirations);
      const remainingMs = earliestTransitionMs - nowMs;
      // Exact millisecond boundary freshness:
      // - If positive: ttlMs is remainingMs (capped at 15m)
      // - If at or past 65-min expiry (remainingMs <= 0): ttlMs = 0 (prevents caching so next request is immediately re-evaluated as OFFLINE)
      ttlMs = remainingMs > 0 ? Math.min(15 * 60 * 1000, remainingMs) : 0;
    }

    const canonicalETag = clusterCacheManager.generateETag(canonicalParams);
    res.setHeader('ETag', canonicalETag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Authorization, If-None-Match');

    // Store in L1 In-Memory Cache with Transition-Aware TTL
    clusterCacheManager.set(cacheKey, responseGates, canonicalETag, {
      userId: req.user.id,
      scopeGroupIds: snapshot.relevantScopeGroupIds || snapshot.assignedScopeGroupIds,
      isDeveloper: snapshot.isDeveloper || false,
      ttlMs,
    });

    if (clientIfNoneMatch && matchesETag(clientIfNoneMatch, canonicalETag)) {
      return res.status(304).end();
    }

    res.setHeader('X-Cluster-Cache', 'MISS');
    res.json(responseGates);
  } catch (error) {
    next(error);
  }
});

async function computeNextMasterIdentifier(client: any, gateId: number, lcNumber: string) {
  const existingMasters = await client.masterUnit.findMany({
    where: { gateId },
    select: { masterSequence: true, serialNumber: true },
    orderBy: { masterSequence: 'asc' },
  });

  const takenSequences = new Set(existingMasters.map((m: any) => m.masterSequence));
  const maxSeq = existingMasters.reduce((max: number, m: any) => Math.max(max, Number(m.masterSequence) || 0), 0);
  let nextSeq = maxSeq + 1;

  while (true) {
    while (takenSequences.has(nextSeq)) {
      nextSeq++;
    }
    const seqStr = nextSeq.toString().padStart(2, '0');
    const candidateSerial = `${lcNumber}-${seqStr}`;
    const conflict = await client.masterUnit.findUnique({
      where: { serialNumber: candidateSerial },
      select: { id: true },
    });
    if (!conflict) {
      return {
        nextSequence: nextSeq,
        formattedSequence: seqStr,
        nextSerialNumber: candidateSerial,
      };
    }
    takenSequences.add(nextSeq);
    nextSeq++;
  }
}

// Get next available master sequence & auto-generated identifier for a gate
router.get('/:gateId/next-master-sequence', authenticate, async (req, res, next) => {
  try {
    const gateId = parseInt(req.params.gateId);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });

    const gate = await prisma.lCGate.findUnique({ where: { id: gateId } });
    if (!gate) return res.status(404).json({ error: 'LC Gate not found' });

    const nextInfo = await computeNextMasterIdentifier(prisma, gateId, gate.lcNumber);

    res.json({
      ...nextInfo,
      gateLcNumber: gate.lcNumber,
    });
  } catch (error) {
    next(error);
  }
});


const createMasterSchema = z.object({
  masterSequence: z.number().int().min(1).max(99).optional(),
  powerSource: z.enum(['SOLAR', 'DIRECT']),
  serialNumber: z.string().optional(),
  autoGenerate: z.boolean().optional(),
  deviceId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
});

// Synchronize historical telemetry transitions for one specific Master Unit & AWS IoT Thing (without deleting other Masters' events)
export async function syncDeviceHistoryToGate(
  gateId: number,
  thingName: string,
  tx: any = prisma,
  masterId?: number | null,
  masterSerial?: string | null
) {
  try {
    let resolvedMasterId = masterId ?? null;
    let resolvedMasterSerial = masterSerial ?? null;
    if (!resolvedMasterId || !resolvedMasterSerial) {
      const reg = await tx.deviceRegistry.findFirst({
        where: { thingName },
        select: { masterId: true, master: { select: { serialNumber: true } } },
      });
      if (!resolvedMasterId && reg?.masterId) resolvedMasterId = reg.masterId;
      if (!resolvedMasterSerial && reg?.master?.serialNumber) resolvedMasterSerial = reg.master.serialNumber;
    }

    const rawTelemetries = await tx.deviceTelemetry.findMany({
      where: {
        thingName,
        topic: { contains: '/telemetry' },
        NOT: [
          { topic: { contains: '/health' } },
          { topic: { contains: '/request' } },
          { topic: { contains: '/manifest' } },
        ],
        status: { not: 'REQUESTED' },
      },
      orderBy: { receivedAt: 'asc' }
    });

    const telemetries = rawTelemetries.filter(isGenuineTelemetryPacket);
    if (telemetries.length === 0) return;

    const eventsToCreate: any[] = [];
    let currentOpen: { openedAt: Date; openedBy: string } | null = null;
    let latestBarrierState: 'OPEN' | 'CLOSED' | null = null;
    let latestTeleAt: Date | null = null;
    let latestTeleId: number | null = null;

    for (const t of telemetries) {
      const parsed = parseBarrierStateFromPayload(t.payload);
      if (!parsed) continue;

      latestBarrierState = parsed;
      latestTeleAt = new Date(t.receivedAt);
      latestTeleId = t.id;

      if (parsed === 'OPEN' && !currentOpen) {
        currentOpen = {
          openedAt: new Date(t.receivedAt),
          openedBy: 'Automated'
        };
      } else if (parsed === 'CLOSED' && currentOpen) {
        const closedAt = new Date(t.receivedAt);
        const durationSeconds = Math.max(1, Math.round((closedAt.getTime() - currentOpen.openedAt.getTime()) / 1000));
        eventsToCreate.push({
          gateId,
          masterId: resolvedMasterId,
          masterSerial: resolvedMasterSerial,
          thingName,
          openedAt: currentOpen.openedAt,
          closedAt,
          durationSeconds,
          status: durationSeconds > 900 ? 'EXTENDED_DELAY' : 'CLOSED',
          openedBy: currentOpen.openedBy,
          closedBy: 'Automated',
          remarks: resolvedMasterSerial
            ? `Physical LimitSwitch transition (${resolvedMasterSerial})`
            : 'Physical LimitSwitch transition detected via AWS IoT Telemetry'
        });
        currentOpen = null;
      }
    }

    // Preserve active unclosed OPEN interval at the end of stream
    if (currentOpen) {
      eventsToCreate.push({
        gateId,
        masterId: resolvedMasterId,
        masterSerial: resolvedMasterSerial,
        thingName,
        openedAt: currentOpen.openedAt,
        closedAt: null,
        durationSeconds: null,
        status: 'OPEN',
        openedBy: currentOpen.openedBy,
        closedBy: null,
        remarks: resolvedMasterSerial
          ? `State transition: OPEN (${resolvedMasterSerial})`
          : 'State transition: OPEN detected by IoT Telemetry'
      });
    }

    // Sync DeviceRegistry.barrierState cleanly from genuine telemetry history
    if (latestBarrierState) {
      await tx.deviceRegistry.updateMany({
        where: { thingName },
        data: {
          barrierState: latestBarrierState,
          lastTelemetryAt: latestTeleAt,
          lastTelemetryId: latestTeleId,
        },
      }).catch(() => {});
    }

    if (eventsToCreate.length > 0) {
      await cleanupDetachedThingEventsInTx(tx, {
        gateId,
        masterId: resolvedMasterId,
        thingName,
      });
      await tx.lCGateEvent.createMany({ data: eventsToCreate });
      await bumpReportRevisionInTx(tx, gateId);
      console.log(`[syncDeviceHistoryToGate] Synced ${eventsToCreate.length} cycles from ${thingName} into Gate #${gateId} (Master #${resolvedMasterId || 'N/A'})`);
    }
  } catch (err) {
    console.warn('[syncDeviceHistoryToGate] Error synchronizing telemetry cycles:', err);
  }
}

router.post('/:gateId/masters', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const gateId = parseInt(req.params.gateId);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });
    if (!(await ensureGateAccess(req, res, gateId))) return;

    const data = createMasterSchema.parse(req.body);

    const gate = await prisma.lCGate.findUnique({ where: { id: gateId } });
    if (!gate) {
      return res.status(404).json({ error: 'LC Gate not found' });
    }

    let dev: any = null;
    if (data.deviceId) {
      dev = await prisma.deviceRegistry.findUnique({ where: { id: data.deviceId } });
      if (!dev) {
        return res.status(400).json({ error: 'Selected device does not exist in AWS IoT registry.' });
      }
      if (dev.gateId && dev.gateId !== gateId && !(await ensureGateAccess(req, res, dev.gateId))) return;
      if (dev.masterId && dev.masterId !== 0) {
        return res.status(400).json({ error: `Device "${dev.thingName}" is already assigned to another Master Unit.` });
      }
    }

    const master = await prisma.$transaction(async (tx) => {
      // Compute next auto-incremented sequence and unique serial identifier atomically
      const autoNext = await computeNextMasterIdentifier(tx, gateId, gate.lcNumber);
      let targetSequence = autoNext.nextSequence;
      let serialNumber = autoNext.nextSerialNumber;

      // Only respect a manually supplied serial if caller did not ask for auto-generation AND it isn't conflicting
      const requestedSerial = data.serialNumber ? data.serialNumber.trim() : '';
      const useAuto = data.autoGenerate === true || !requestedSerial || requestedSerial.endsWith('(Virtual Master)');
      if (!useAuto && requestedSerial !== autoNext.nextSerialNumber) {
        const dup = await tx.masterUnit.findUnique({ where: { serialNumber: requestedSerial }, select: { id: true } });
        if (!dup) {
          serialNumber = requestedSerial;
        }
      }

      const created = await tx.masterUnit.create({
        data: {
          serialNumber,
          masterSequence: targetSequence,
          powerSource: data.powerSource,
          gateId,
        },
        include: {
          childDevices: true,
        },
      });

      // Link device in registry
      if (data.deviceId && dev) {
        await tx.deviceRegistry.update({
          where: { id: data.deviceId },
          data: { masterId: created.id, gateId: created.gateId }
        }).catch(console.warn);
        await syncDeviceHistoryToGate(gateId, dev.thingName, tx, created.id, created.serialNumber);
      }

      // Bump revision for gate directory
      await bumpDirectoryRevision([], true, tx);

      return created;
    }, { maxWait: 5000, timeout: 20000 });

    clusterCacheManager.clear();
    if (data.deviceId) {
      broadcastGateTelemetry(gateId).catch(console.warn);
    }
    res.status(201).json(master);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'Master Unit serial number must be unique.' });
    }
    next(error);
  }
});

const updateMasterSchema = z.object({
  powerSource: z.enum(['SOLAR', 'DIRECT']).optional(),
  serialNumber: z.string().optional(),
  deviceId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
  unassignDevice: z.boolean().optional(),
});

// PUT /masters/:id - Update Master Unit configuration (power source, serial, hardware device mapping)
router.put('/masters/:id', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid master ID' });

    const existing = await prisma.masterUnit.findUnique({
      where: { id },
      include: { gate: true, deviceRegistry: true }
    });
    if (!existing) return res.status(404).json({ error: 'Master Unit not found' });
    if (existing.gateId && !(await ensureGateAccess(req, res, existing.gateId))) return;

    const data = updateMasterSchema.parse(req.body);
    if (data.deviceId !== undefined && data.deviceId !== null) {
      const candidate = await prisma.deviceRegistry.findUnique({ where: { id: data.deviceId }, select: { gateId: true } });
      if (candidate?.gateId && candidate.gateId !== existing.gateId && !(await ensureGateAccess(req, res, candidate.gateId))) {
        return;
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      let serialNumber = existing.serialNumber;
      const seqStr = existing.masterSequence.toString().padStart(2, '0');
      const virtualSerial = `${existing.gate?.lcNumber || 'LC'}-${seqStr} (Virtual Master)`;

      if (data.serialNumber && data.serialNumber.trim() && data.serialNumber.trim() !== existing.serialNumber) {
        serialNumber = data.serialNumber.trim();
      }

      // Handle unassigning device cleanly (clean orphan events + revert to Virtual Master if no custom serial)
      if (data.unassignDevice) {
        if (existing.deviceRegistry) {
          await cleanupDetachedThingEventsInTx(tx, {
            gateId: existing.gateId,
            masterId: id,
            thingName: existing.deviceRegistry.thingName,
          });
        }
        await tx.deviceRegistry.updateMany({
          where: { masterId: id },
          data: { masterId: null, gateId: null, childDeviceId: null }
        });
        if (!data.serialNumber || serialNumber === existing.serialNumber) {
          serialNumber = virtualSerial;
        }
      }

      // Handle linking or changing device
      if (data.deviceId !== undefined && data.deviceId !== null) {
        const linkedDev = await tx.deviceRegistry.findUnique({
          where: { id: data.deviceId }
        });
        if (!linkedDev) {
          throw new Error('Device not found in registry');
        }
        if (linkedDev.masterId && linkedDev.masterId !== id) {
          throw new Error(`Device "${linkedDev.thingName}" is already assigned to another Master Unit.`);
        }
        // Unlink previous device & clean its detached operational cycles on this master
        if (existing.deviceRegistry && existing.deviceRegistry.id !== data.deviceId) {
          await cleanupDetachedThingEventsInTx(tx, {
            gateId: existing.gateId,
            masterId: id,
            thingName: existing.deviceRegistry.thingName,
          });
          await tx.deviceRegistry.updateMany({
            where: { masterId: id, id: { not: data.deviceId } },
            data: { masterId: null, gateId: null, childDeviceId: null }
          });
        }
        // If new device moved from another gate, clean its old gate's events
        if (linkedDev.gateId && linkedDev.gateId !== existing.gateId) {
          await cleanupDetachedThingEventsInTx(tx, {
            gateId: linkedDev.gateId,
            masterId: linkedDev.masterId,
            thingName: linkedDev.thingName,
          });
        }
        // Link new device
        await tx.deviceRegistry.update({
          where: { id: data.deviceId },
          data: { masterId: id, gateId: existing.gateId }
        });
        await syncDeviceHistoryToGate(existing.gateId, linkedDev.thingName, tx, id, serialNumber);
      }

      if (serialNumber !== existing.serialNumber) {
        const dup = await tx.masterUnit.findUnique({ where: { serialNumber } });
        if (dup && dup.id !== id) {
          throw new Error(`Master Unit with serial number "${serialNumber}" already exists.`);
        }
      }

      const m = await tx.masterUnit.update({
        where: { id },
        data: {
          powerSource: data.powerSource || existing.powerSource,
          serialNumber,
        },
        include: { childDevices: true, deviceRegistry: true }
      });

      await bumpDirectoryRevision([existing.gateId], true, tx);

      return {
        ...m,
        deviceRegistries: m.deviceRegistry ? [m.deviceRegistry] : [],
      };
    }, { maxWait: 5000, timeout: 20000 });

    clusterCacheManager.clear();
    broadcastGateTelemetry(existing.gateId).catch(console.warn);
    res.json(updated);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'Master Unit serial number must be unique.' });
    }
    next(error);
  }
});

function getSlaveLetter(type: string): string {
  switch (type) {
    case 'LIMIT_SWITCH':
    case 'DEVICE_1':
      return 'A';
    case 'HALL_EFFECT':
    case 'DEVICE_2':
      return 'B';
    case 'TILT_SENSOR':
      return 'C';
    default:
      return 'A';
  }
}

// Get next available device sequence for a master
router.get('/masters/:masterId/next-device-sequence', authenticate, async (req, res, next) => {
  try {
    const masterId = parseInt(req.params.masterId);
    if (isNaN(masterId)) return res.status(400).json({ error: 'Invalid master ID' });

    const master = await prisma.masterUnit.findUnique({ where: { id: masterId } });
    if (!master) return res.status(404).json({ error: 'Master Unit not found' });
    
    const type = (req.query.type as string) || 'LIMIT_SWITCH';
    const letter = getSlaveLetter(type);
    const prefix = `${master.serialNumber}-${letter}`;

    const existing = await prisma.childDevice.findMany({
      where: { masterId, ...(type ? { type } : {}) },
      select: { deviceSequence: true, serialNumber: true }
    });
    
    const taken = new Set<number>();
    for (const d of existing) {
      if (d.deviceSequence && d.deviceSequence > 0) taken.add(d.deviceSequence);
      if (d.serialNumber === prefix) {
        taken.add(1);
      } else if (d.serialNumber && d.serialNumber.startsWith(`${prefix}-`)) {
        const numPart = parseInt(d.serialNumber.slice(`${prefix}-`.length), 10);
        if (!isNaN(numPart)) taken.add(numPart);
      }
    }

    let nextSeq = 1;
    while (taken.has(nextSeq)) {
      nextSeq++;
    }

    // Ensure global uniqueness against all child devices in DB
    while (await prisma.childDevice.findUnique({ where: { serialNumber: `${master.serialNumber}-${letter}-${nextSeq}` } })) {
      nextSeq++;
    }

    res.json({ 
      nextSequence: nextSeq,
      serialNumber: `${master.serialNumber}-${letter}-${nextSeq}`
    });
  } catch (error) {
    next(error);
  }
});

const createDeviceSchema = z.object({
  type: z.enum(['LIMIT_SWITCH', 'HALL_EFFECT', 'TILT_SENSOR', 'DEVICE_1', 'DEVICE_2']),
  deviceSequence: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : Number(val)),
    z.number().int().min(1).max(999).optional()
  ),
  serialNumber: z.string().optional(),
  deviceId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
  imageBase64: z.string().optional().nullable(),
  latitude: z.preprocess((v) => (v !== undefined && v !== null && v !== '' ? Number(v) : undefined), z.number().optional().nullable()),
  longitude: z.preprocess((v) => (v !== undefined && v !== null && v !== '' ? Number(v) : undefined), z.number().optional().nullable()),
});

// Add a Child Device to a Master
router.post('/masters/:masterId/devices', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const masterId = parseInt(req.params.masterId);
    if (isNaN(masterId)) return res.status(400).json({ error: 'Invalid master ID' });
    
    const data = createDeviceSchema.parse(req.body);
    
    const master = await prisma.masterUnit.findUnique({ where: { id: masterId } });
    if (!master) {
      return res.status(404).json({ error: 'Master Unit not found' });
    }
    if (master.gateId && !(await ensureGateAccess(req, res, master.gateId))) return;

    const letter = getSlaveLetter(data.type);
    const prefix = `${master.serialNumber}-${letter}`;

    // Find all existing child devices for this master to inspect existing sequences
    const existingDevices = await prisma.childDevice.findMany({
      where: { masterId, type: data.type },
      select: { deviceSequence: true, serialNumber: true }
    });

    const takenSequences = new Set<number>();
    for (const d of existingDevices) {
      if (d.deviceSequence && d.deviceSequence > 0) takenSequences.add(d.deviceSequence);
      if (d.serialNumber === prefix) takenSequences.add(1);
      else if (d.serialNumber && d.serialNumber.startsWith(`${prefix}-`)) {
        const numPart = parseInt(d.serialNumber.slice(`${prefix}-`.length), 10);
        if (!isNaN(numPart)) takenSequences.add(numPart);
      }
    }
    
    let targetSequence = data.deviceSequence;
    if (!targetSequence || takenSequences.has(targetSequence)) {
      let nextSeq = 1;
      while (takenSequences.has(nextSeq)) {
        nextSeq++;
      }
      targetSequence = nextSeq;
    }

    // Determine derived serial number
    let serialNumber = data.serialNumber ? data.serialNumber.trim() : `${master.serialNumber}-${letter}-${targetSequence}`;

    // If candidate serialNumber exists, automatically increment suffix to avoid duplication errors
    let existingSerial = await prisma.childDevice.findUnique({ where: { serialNumber } });
    while (existingSerial) {
      targetSequence++;
      serialNumber = `${master.serialNumber}-${letter}-${targetSequence}`;
      existingSerial = await prisma.childDevice.findUnique({ where: { serialNumber } });
    }

    const device = await prisma.$transaction(async (tx) => {
      const created = await tx.childDevice.create({
        data: {
          type: data.type,
          serialNumber,
          deviceSequence: targetSequence,
          masterId,
        },
      });

      // Auto-link DeviceRegistry
      if (data.deviceId) {
        await tx.deviceRegistry.updateMany({
          where: { id: data.deviceId },
          data: { childDeviceId: created.id, masterId: master.id, gateId: master.gateId }
        }).catch(console.warn);
      } else {
        await tx.deviceRegistry.updateMany({
          where: {
            OR: [{ thingName: serialNumber }, { serialNumber: serialNumber }]
          },
          data: { childDeviceId: created.id, masterId: master.id, gateId: master.gateId }
        }).catch(console.warn);
      }

      // Bump revision for gate
      if (master.gateId) {
        const now = new Date();
        await tx.masterUnit.update({ where: { id: master.id }, data: { updatedAt: now } }).catch(() => {});
        await tx.lCGate.update({ where: { id: master.gateId }, data: { updatedAt: now } }).catch(() => {});
        await bumpDirectoryRevision([master.gateId], true, tx);
      }

      // Save installation evidence if image provided
      if (data.imageBase64 && req.user?.id) {
        try {
          const uploadsDir = path.join(process.cwd(), 'uploads');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          const matches = data.imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          const buf = matches && matches[2] ? Buffer.from(matches[2], 'base64') : Buffer.from(data.imageBase64, 'base64');

          let stampedBuffer: Buffer = buf;
          try {
            const image = await Jimp.read(buf);
            if (image.bitmap && (image.bitmap.width > 2048 || image.bitmap.height > 2048)) {
              if (image.bitmap.width >= image.bitmap.height) {
                image.resize({ w: 2048 });
              } else {
                image.resize({ h: 2048 });
              }
            }
            const dateStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            const latStr = data.latitude !== undefined && data.latitude !== null ? Number(data.latitude).toFixed(6) : 'N/A';
            const lngStr = data.longitude !== undefined && data.longitude !== null ? Number(data.longitude).toFixed(6) : 'N/A';
            const text = `Lat: ${latStr} | Lng: ${lngStr} | ${dateStr}`;

            const fontWhite = await loadFont(SANS_16_WHITE);
            const fontBlack = await loadFont(SANS_16_BLACK);
            image.print({ font: fontBlack, x: 13, y: 13, text });
            image.print({ font: fontWhite, x: 12, y: 12, text });
            stampedBuffer = await image.getBuffer('image/jpeg');
          } catch (jErr) {
            console.warn('Jimp watermark for slave photo failed:', jErr);
          }

          const filename = `${crypto.randomUUID()}.jpg`;
          const filepath = path.join(uploadsDir, filename);
          try {
            fs.writeFileSync(filepath, stampedBuffer);
          } catch (fErr) {
            console.warn('Local fs write failed for slave photo:', fErr);
          }

          let imageUrl = `/uploads/${filename}`;
          try {
            const uploadResult = await new Promise<any>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Cloudinary timeout')), 8000);
              const stream = cloudinary.uploader.upload_stream(
                { folder: 'lc-platform-evidence', resource_type: 'image' },
                (err, res) => {
                  clearTimeout(timeout);
                  if (err) reject(err);
                  else resolve(res);
                }
              );
              stream.end(stampedBuffer);
            });
            if (uploadResult?.secure_url) {
              imageUrl = uploadResult.secure_url;
            }
          } catch (cldErr) {
            console.warn('Cloudinary upload for slave photo failed, using local URL:', cldErr);
          }

          await tx.installationEvidence.create({
            data: {
              category: data.type,
              imageUrl,
              latitude: data.latitude ?? null,
              longitude: data.longitude ?? null,
              userId: req.user.id,
              masterId,
              childDeviceId: created.id,
            }
          });
        } catch (evErr) {
          console.warn('Failed to save child device installation evidence in transaction:', evErr);
        }
      }

      return created;
    });

    clusterCacheManager.clear();

    res.status(201).json(device);
  } catch (error) {
    next(error);
  }
});

// Delete a Master Unit (cascades to devices and evidences)
// NOTE: must be declared BEFORE '/:id' so '/masters/:id' is not matched as a gate id.
router.delete('/masters/:id', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid master ID' });

    const preMaster = await prisma.masterUnit.findUnique({
      where: { id },
      select: { gateId: true },
    });
    if (!preMaster) return res.status(404).json({ error: 'Master Unit not found' });
    if (preMaster.gateId && !(await ensureGateAccess(req, res, preMaster.gateId))) return;
    
    let deletedGateId: number | null = null;
    await prisma.$transaction(async (tx) => {
      const targetMaster = await tx.masterUnit.findUnique({
        where: { id },
        select: { gateId: true, deviceRegistry: { select: { thingName: true } } },
      });
      deletedGateId = targetMaster?.gateId ?? null;

      // Clean up evidence files
      const masterEvs = await tx.installationEvidence.findMany({
        where: { masterId: id },
        select: { imageUrl: true },
      });
      for (const ev of masterEvs) {
        await deleteEvidenceFile(ev.imageUrl);
      }

      // Unconditionally remove & tombstone operational events belonging to this Master/Thing even on multi-master gates
      if (targetMaster?.gateId) {
        await cleanupDetachedThingEventsInTx(tx, {
          gateId: targetMaster.gateId,
          masterId: id,
          thingName: targetMaster.deviceRegistry?.thingName || null,
        });
      }

      // Explicitly detach any mapped hardware devices back to the unassigned registry pool
      await tx.deviceRegistry.updateMany({
        where: { masterId: id },
        data: { masterId: null, gateId: null, childDeviceId: null }
      });
      await tx.masterUnit.delete({ where: { id } });

      if (targetMaster?.gateId) {
        const remainingCount = await tx.masterUnit.count({
          where: { gateId: targetMaster.gateId }
        });
        if (remainingCount === 0) {
          const orphanEvents = await tx.lCGateEvent.findMany({
            where: { gateId: targetMaster.gateId },
            select: { id: true, gateId: true, openedAt: true }
          });
          if (orphanEvents.length > 0) {
            await tx.lCGateEventTombstone.createMany({
              data: orphanEvents.map(e => ({
                eventId: e.id,
                gateId: e.gateId,
                openedAt: e.openedAt,
                deletedAt: new Date()
              }))
            });
            await tx.lCGateEvent.deleteMany({
              where: { gateId: targetMaster.gateId }
            });
            await bumpReportRevisionInTx(tx, targetMaster.gateId);
          }
        }
        const now = new Date();
        await tx.lCGate.update({ where: { id: targetMaster.gateId }, data: { updatedAt: now } }).catch(() => {});
        await bumpDirectoryRevision([targetMaster.gateId], true, tx);
      } else {
        await bumpDirectoryRevision([], true, tx);
      }
    }, { maxWait: 5000, timeout: 20000 });
    clusterCacheManager.clear();
    if (deletedGateId) {
      broadcastGateTelemetry(deletedGateId).catch(console.warn);
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Delete a Slave Device
router.delete('/devices/:id', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid device ID' });

    const preDevice = await prisma.childDevice.findUnique({
      where: { id },
      include: { master: { select: { gateId: true } } },
    });
    if (!preDevice) return res.status(404).json({ error: 'Slave Device not found' });
    if (preDevice.master?.gateId && !(await ensureGateAccess(req, res, preDevice.master.gateId))) return;
    
    await prisma.$transaction(async (tx) => {
      const targetDevice = await tx.childDevice.findUnique({
        where: { id },
        include: { master: { select: { id: true, gateId: true } } },
      });

      // Clean up evidence files for this slave device
      const childEvs = await tx.installationEvidence.findMany({
        where: { childDeviceId: id },
        select: { imageUrl: true },
      });
      for (const ev of childEvs) {
        await deleteEvidenceFile(ev.imageUrl);
      }

      // Explicitly detach child device mapping from registry pool
      await tx.deviceRegistry.updateMany({
        where: { childDeviceId: id },
        data: { childDeviceId: null }
      });
      await tx.childDevice.delete({ where: { id } });

      if (targetDevice?.master?.gateId) {
        const now = new Date();
        if (targetDevice.master.id) {
          await tx.masterUnit.update({ where: { id: targetDevice.master.id }, data: { updatedAt: now } }).catch(() => {});
        }
        await tx.lCGate.update({ where: { id: targetDevice.master.gateId }, data: { updatedAt: now } }).catch(() => {});
        await bumpDirectoryRevision([targetDevice.master.gateId], true, tx);
      } else {
        await bumpDirectoryRevision([], true, tx);
      }
    }, { maxWait: 5000, timeout: 20000 });
    clusterCacheManager.clear();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Get single LC Gate with masters, childDevices, and evidences
router.get('/:id', authenticate, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

    const isAuthorized = await verifyGateAccess(req.user, id, prisma);
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Access denied: Gate is outside your assigned scope or geographical jurisdiction' });
    }

    const rawGate = await prisma.lCGate.findUnique({
      where: { id },
      include: {
        station: { select: { id: true, code: true, name: true, division: true, zone: true } },
        deviceRegistries: true,
        masters: {
          orderBy: { masterSequence: 'asc' },
          include: {
            childDevices: {
              orderBy: { deviceSequence: 'asc' },
              include: { evidences: true }
            },
            evidences: true,
            deviceRegistry: true
          }
        }
      }
    });

    if (!rawGate) return res.status(404).json({ error: 'Gate not found' });
    const gate = hydrateGateMasters(rawGate as any);

    // Single-gate composite revision token
    const timestamps = [
      gate.updatedAt ? new Date(gate.updatedAt).getTime() : 0,
      ...gate.masters.map((m: any) => (m.updatedAt ? new Date(m.updatedAt).getTime() : (m.createdAt ? new Date(m.createdAt).getTime() : 0))),
      ...gate.masters.flatMap((m: any) =>
        (m.childDevices || []).map((c: any) => (c.updatedAt ? new Date(c.updatedAt).getTime() : (c.createdAt ? new Date(c.createdAt).getTime() : 0)))
      ),
      ...gate.masters.flatMap((m: any) =>
        (m.evidences || []).map((e: any) => (e.updatedAt ? new Date(e.updatedAt).getTime() : (e.createdAt ? new Date(e.createdAt).getTime() : 0)))
      ),
      ...gate.masters.flatMap((m: any) =>
        (m.childDevices || []).flatMap((c: any) =>
          (c.evidences || []).map((e: any) => (e.updatedAt ? new Date(e.updatedAt).getTime() : (e.createdAt ? new Date(e.createdAt).getTime() : 0)))
        )
      ),
      ...gate.deviceRegistries.map((d: any) => (d.updatedAt ? new Date(d.updatedAt).getTime() : (d.createdAt ? new Date(d.createdAt).getTime() : 0))),
    ];
    const maxTimestamp = Math.max(0, ...timestamps);
    const gateETag = `W/"gate-${id}-rev-${maxTimestamp}"`;

    res.setHeader('ETag', gateETag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Authorization, If-None-Match');

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && matchesETag(ifNoneMatch, gateETag)) {
      return res.status(304).end();
    }

    const basePayload = await getGateTelemetryPayload(id);
    if (!basePayload) return res.status(404).json({ error: 'Gate telemetry not available' });

    const telemetryData = buildGateTelemetry(gate);
    return res.json({
      ...basePayload,
      cluster: telemetryData.cluster,
      awsConfig: telemetryData.awsConfig,
    });
  } catch (error) {
    next(error);
  }
});

// Helper to build lightweight AWS Fleet Provisioning status and hardware device topology
function buildGateTelemetry(gate: any) {
  const masterList = gate.masters || [];
  const isSolar = masterList.some((m: any) => m.powerSource === 'SOLAR');
  const registeredDevices = gate.deviceRegistries || [];
  const now = new Date();

  // Strictly match each Master Unit 1-to-1 with its linked DeviceRegistry (never by guessing serialNumber)
  const mastersWithRegistry = masterList.map((m: any) => {
    const reg = m.deviceRegistry || (m.deviceRegistries && m.deviceRegistries[0]) || registeredDevices.find((d: any) => d.masterId === m.id) || null;
    const isVirtual = !reg;
    return {
      ...m,
      isVirtual,
      awsThingName: reg ? reg.thingName : null,
      awsStatus: reg ? reg.status : null,
      connectivityStatus: reg ? reg.connectivityStatus : null,
      barrierState: reg ? reg.barrierState : null,
      deviceName: reg?.attributes?.deviceName || reg?.attributes?.hardware?.deviceName || null,
      description: reg?.attributes?.description || reg?.attributes?.hardware?.description || null,
      firmwareVersion: reg ? reg.firmwareVersion : null,
      hardwareVersion: reg ? reg.hardwareVersion : null,
      dateOfMfg: reg ? reg.dateOfMfg : null,
      sensors: reg ? reg.sensors : null,
      components: reg ? reg.components : null,
      attributes: reg ? reg.attributes : null,
      metadata: reg ? reg.metadata : null,
    };
  });

  const slavesList: any[] = [];
  masterList.forEach((m: any) => {
    const reg = m.deviceRegistry || (m.deviceRegistries && m.deviceRegistries[0]) || registeredDevices.find((d: any) => d.masterId === m.id) || null;
    const manifestSlaves = reg?.attributes?.slaves || reg?.components || [];
    (m.childDevices || []).forEach((c: any) => {
      const manifestSlave = Array.isArray(manifestSlaves)
        ? manifestSlaves.find((s: any) => s.slaveId === c.serialNumber || (s.type && s.type === c.type))
        : null;

      slavesList.push({
        id: c.id,
        serialNumber: c.serialNumber,
        type: c.type,
        sequence: c.deviceSequence,
        status: null,
        awsThingName: null, // Slaves do not have individual cloud connectivity
        masterSerialNumber: m.serialNumber,
        sensors: manifestSlave?.sensors || null,
        components: null,
      });
    });
  });

  const resolved = resolveGateStateFromThings(gate, now.getTime());

  const gateInfo = {
    id: gate.id,
    lcNumber: gate.lcNumber,
    name: gate.name || gate.locationName,
    locationName: gate.locationName,
    zone: gate.zone,
    division: gate.division,
    stationId: gate.stationId || null,
    station: gate.station || null,
    latitude: gate.latitude,
    longitude: gate.longitude,
    isConfigured: resolved.isConfigured,
    currentStatus: resolved.status,
    status: resolved.status,
    isOnline: resolved.isOnline,
    deviceStatus: resolved.hasHardware ? resolved.deviceStatus : null,
    lastSeenAt: resolved.lastSeenAt,
    onlineMastersCount: resolved.onlineMastersCount,
    hardwareMastersCount: resolved.hardwareMastersCount,
    powerSource: isSolar ? 'SOLAR' : 'DIRECT',
    mastersCount: masterList.length,
    slavesCount: slavesList.length,
    masters: mastersWithRegistry,
    slaves: slavesList,
    deviceRegistries: registeredDevices,
  };

  return {
    cluster: gateInfo,
    gate: gateInfo,
    awsConfig: {
      provisioningMode: 'AWS_FLEET_PROVISIONING',
      region: 'ap-south-1 (Mumbai)',
      status: registeredDevices.length > 0 ? 'ACTIVE_FLEET_MAPPED' : 'FLEET_MAPPING_PENDING',
      description: 'Physical hardware devices mapped and registered with AWS IoT Core and RDS Device Registry.',
      registeredCount: registeredDevices.length,
    },
    timestamp: now.toISOString()
  };
}

// Get Live Telemetry, Historical MQTT Payloads & Device Inspection Data for a Gate
router.get('/:id/telemetry', authenticate, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

    const isAuthorized = await verifyGateAccess(req.user, id, prisma);
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Access denied: You do not have geographical jurisdiction for this Level Crossing Gate.' });
    }

    const rawGate = await prisma.lCGate.findUnique({
      where: { id },
      include: {
        station: { select: { id: true, code: true, name: true, division: true, zone: true } },
        deviceRegistries: true,
        masters: {
          orderBy: { masterSequence: 'asc' },
          include: {
            childDevices: {
              orderBy: { deviceSequence: 'asc' },
              include: { evidences: true }
            },
            evidences: true,
            deviceRegistry: true
          }
        }
      }
    });

    if (!rawGate) return res.status(404).json({ error: 'Gate not found' });
    const gate = hydrateGateMasters(rawGate as any);

    const basePayload = await getGateTelemetryPayload(id);
    if (!basePayload) return res.status(404).json({ error: 'Gate telemetry not available' });

    const telemetryData = buildGateTelemetry(gate);
    return res.json({
      ...basePayload,
      cluster: telemetryData.cluster,
      awsConfig: telemetryData.awsConfig,
    });
  } catch (error) {
    next(error);
  }
});

// Trigger health check command to gate's master hardware over AWS IoT Core MQTT broker
router.post('/:id/health-check', authenticate, requireAnyModule(['lc-gates', 'cluster', 'devices']), async (req: any, res, next) => {
  try {
    const idNum = parseInt(req.params.id);
    const gateWhere = !isNaN(idNum) ? { id: idNum } : { lcNumber: req.params.id };

    const rawGate = await prisma.lCGate.findFirst({
      where: gateWhere,
      include: {
        masters: {
          orderBy: { masterSequence: 'asc' },
          include: { deviceRegistry: true },
        },
        deviceRegistries: true,
      }
    });

    if (!rawGate) return res.status(404).json({ error: 'Gate not found' });
    if (!(await ensureGateAccess(req, res, rawGate.id))) return;
    const gate = hydrateGateMasters(rawGate as any);

    const reqMasterId = req.body?.masterId ? Number(req.body.masterId) : null;
    const reqThingName = req.body?.thingName ? String(req.body.thingName).trim() : null;

    // Collect strictly linked physical hardware Things (no fallback to virtual master serial or lcNumber)
    const targetList: Array<{ thingName: string; deviceRegistryId: number; masterId: number }> = [];
    for (const m of gate.masters) {
      const reg = m.deviceRegistry || gate.deviceRegistries.find((d: any) => d.masterId === m.id);
      if (reqMasterId && m.id !== reqMasterId) continue;
      if (reqThingName && reg?.thingName !== reqThingName) continue;
      if (reg?.thingName) {
        targetList.push({ thingName: reg.thingName, deviceRegistryId: reg.id, masterId: m.id });
      }
    }

    if (targetList.length === 0) {
      return res.status(400).json({
        error: 'No AWS IoT Thing is assigned to this gate/master unit. Assign hardware first.',
      });
    }

    const pingResults: any[] = [];
    let firstRequestId = '';
    let firstTopic = '';
    let anyMqttSuccess = false;
    let lastMqttError: string | null = null;

    for (const target of targetList) {
      const topic = `lc-gate/${target.thingName}/health/request`;
      const requestId = `hc_${Date.now()}_${target.masterId}`;
      const commandPayload = {
        action: 'HEALTH_CHECK',
        MasterDeviceId: target.thingName,
        gateId: gate.id,
        masterId: target.masterId,
        lcNumber: gate.lcNumber,
        requestId,
        timestamp: new Date().toISOString(),
      };

      const mqttResult = await publishMqttMessage(topic, commandPayload);
      if (mqttResult.success) anyMqttSuccess = true;
      else if (mqttResult.error) lastMqttError = mqttResult.error;

      if (!firstRequestId) {
        firstRequestId = requestId;
        firstTopic = topic;
      }

      pingResults.push({
        thingName: target.thingName,
        masterId: target.masterId,
        topic,
        requestId,
        mqttDelivered: mqttResult.success,
        mqttError: mqttResult.error || null,
      });
    }

    const targetNamesStr = pingResults.map(p => p.thingName).join(', ');
    res.json({
      success: anyMqttSuccess,
      message: anyMqttSuccess
        ? `Health check command published over AWS IoT MQTT to ${targetNamesStr}`
        : `AWS IoT MQTT broker unreachable for ${targetNamesStr} (${lastMqttError || 'not configured'})`,
      topic: firstTopic,
      requestId: firstRequestId,
      mqttDelivered: anyMqttSuccess,
      mqttError: lastMqttError,
      targetsCount: pingResults.length,
      pingedTargets: pingResults,
    });
  } catch (err) {
    next(err);
  }
});

// Delete an LC Gate (cascades) - declared last so it doesn't shadow the paths above.
router.delete('/:id', authenticate, requireModule('cluster'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });
    if (!(await ensureGateAccess(req, res, id))) return;
    
    await prisma.$transaction(async (tx) => {

      // 1. Capture and preserve all events belonging to this gate in Tombstones prior to cascade delete
      const eventsToDelete = await tx.lCGateEvent.findMany({
        where: { gateId: id },
         select: { id: true, gateId: true, openedAt: true, closedAt: true, durationSeconds: true, status: true, openedBy: true, closedBy: true, trainNumber: true, remarks: true },
      });

      const revision = await bumpReportRevisionInTx(tx, id);

      if (eventsToDelete.length > 0) {
        await tx.lCGateEventTombstone.createMany({
          data: eventsToDelete.map((e) => ({
            eventId: e.id,
            gateId: e.gateId,
            openedAt: e.openedAt,
          })),
          skipDuplicates: true,
        });

        await tx.lCGateEventChangeLog.createMany({
          data: eventsToDelete.map((e) => ({
            eventId: e.id,
            gateId: e.gateId,
            opType: 'DELETE',
            gateRevision: revision,
            openedAt: e.openedAt ?? null,
          })),
          skipDuplicates: true,
        });
      }

      // 2. Explicitly detach all hardware devices in DeviceRegistry back to unassigned inventory pool
      await tx.deviceRegistry.updateMany({
        where: { gateId: id },
        data: { gateId: null, masterId: null, childDeviceId: null }
      });

      // 3. Delete the gate (cascades deletion of LCGateEvent)
      await tx.lCGate.delete({ where: { id } });

      await bumpDirectoryRevision([], true, tx);
    }, { timeout: 120000, maxWait: 10000 });
    clusterCacheManager.clear();
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
