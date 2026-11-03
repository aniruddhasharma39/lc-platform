import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { buildUserGateWhereClause, verifyGateAccess } from '../lib/railwayHierarchy';
import { authenticate } from '../middleware/auth';
import { RAILWAY_DATA, RAILWAY_ZONES, RAILWAY_STATIONS, divisionsForZone, stationsForDivision, findZoneForDivision } from '../lib/railwayData';

import { publishMqttMessage } from '../lib/iotClient';
import { broadcastGateTelemetry, getGateTelemetryPayload } from '../lib/telemetryWs';
import { bumpDirectoryRevision, getDirectoryRevisionToken } from '../lib/revisionManager';
import { bumpReportRevisionInTx, recordEventChangeInTx } from '../lib/reportRevisionManager';
import { clusterCacheManager } from '../lib/clusterCacheManager';

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
router.post('/stations', authenticate, async (req, res, next) => {
  try {
    const data = createStationSchema.parse(req.body);
    const cleanCode = data.code.trim().toUpperCase();
    const cleanName = data.name.trim();
    const cleanDiv = data.division.trim();
    const cleanZone = (data.zone || findZoneForDivision(cleanDiv) || 'Western Railway').trim();

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

// GET /dashboard-summary - Home screen KPIs, gate cycle stats & cluster map coordinates
router.get('/dashboard-summary', authenticate, async (req: any, res, next) => {
  try {
    const isDeveloper = req.user?.role === 'Developer';

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


    // Start of today (00:00:00)
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const gates = await prisma.lCGate.findMany({
      where: whereClause,
      orderBy: { lcNumber: 'asc' },
      include: {
        station: { select: { id: true, code: true, name: true, division: true, zone: true } },
        deviceRegistries: true,
        events: {
          orderBy: { openedAt: 'desc' },
          take: 50,
        },
        masters: {
          orderBy: { masterSequence: 'asc' },
          include: {
            childDevices: true
          }
        }
      }
    });

    // Gather thing identifiers ONLY from actually configured masters
    const allThingNames: string[] = [];
    gates.forEach(g => {
      g.masters.forEach(m => {
        if (m.serialNumber) allThingNames.push(m.serialNumber);
      });
      g.deviceRegistries.forEach(d => {
        if (d.masterId !== null && d.thingName) allThingNames.push(d.thingName);
      });
    });

    const recentTelemetries = await prisma.deviceTelemetry.findMany({
      where: { thingName: { in: allThingNames } },
      orderBy: { receivedAt: 'desc' },
      take: 200,
    }).catch(() => []);

    // Helper map for latest telemetry per thing
    const latestTeleMap = new Map<string, any>();
    recentTelemetries.forEach(t => {
      if (!latestTeleMap.has(t.thingName)) {
        latestTeleMap.set(t.thingName, t);
      }
    });

    let totalCyclesToday = 0;
    let totalOpenGates = 0;
    let totalClosedGates = 0;

    const mappedGates = gates.map(gate => {
      const hasMasters = gate.masters.length > 0;
      const isSolar = hasMasters && gate.masters.some(m => m.powerSource === 'SOLAR');
      const primaryMaster = hasMasters ? gate.masters[0]?.serialNumber : 'Unassigned';
      const slavesCount = gate.masters.reduce((acc, m) => acc + (m.childDevices?.length || 0), 0);
      const assignedScope: any = null;

      if (!hasMasters) {
        // Gate has NO master hardware attached! Cannot have live telemetry or cycles.
        // It is UNCONFIGURED, so it must NOT increment totalClosedGates or totalOpenGates.
        return {
          id: gate.id,
          lcNumber: gate.lcNumber,
          name: gate.name || gate.locationName,
          locationName: gate.locationName,
          zone: gate.zone || 'Central Railway',
          division: gate.division || 'Pune',
          latitude: gate.latitude,
          longitude: gate.longitude,
          powerSource: 'NOT_CONFIGURED',
          status: 'UNCONFIGURED',
          hasMaster: false,
          todayCycles: 0,
          totalCycles: 0,
          lastClosedAt: null,
          lastClosedFormatted: 'No master unit assigned',
          masterSerialNumber: 'Unassigned',
          mastersCount: 0,
          slavesCount: 0,
          stationId: gate.stationId || null,
          stationCode: (gate as any).station?.code || null,
          stationName: (gate as any).station?.name || null,
          scopeGroupId: assignedScope?.id || null,
          scopeGroupName: assignedScope?.name || null,
          scopeGroupColor: assignedScope?.color || null,
        };
      }

      // Compute cycles for today
      const todayEvents = gate.events.filter(e => {
        const opTime = new Date(e.openedAt).getTime();
        return opTime >= startOfToday.getTime();
      });

      const todayCyclesCount = todayEvents.length;
      totalCyclesToday += todayCyclesCount;

      // Last closed time
      const lastClosedEvent = gate.events.find(e => e.closedAt !== null);
      let lastClosedAt: string | null = null;
      let lastClosedFormatted: string = 'No recorded closure';

      if (lastClosedEvent && lastClosedEvent.closedAt) {
        lastClosedAt = lastClosedEvent.closedAt.toISOString();
        const closedDate = new Date(lastClosedEvent.closedAt);
        const isToday = closedDate.toDateString() === new Date().toDateString();
        const timeStr = closedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (isToday) {
          lastClosedFormatted = `Today at ${timeStr}`;
        } else {
          lastClosedFormatted = `${closedDate.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`;
        }
      }

      // Gate status resolution strictly from configured master hardware
      const latestTele = latestTeleMap.get(primaryMaster);
      const telePayload = latestTele?.payload as any;
      const rawTeleStatus = telePayload?.Status ? String(telePayload.Status).trim().toUpperCase() : null;

      const activeEvent = gate.events.find(e => e.status === 'OPEN' || !e.closedAt);

      let status: 'OPEN' | 'CLOSED' = 'CLOSED';
      if (rawTeleStatus === 'OPEN' || rawTeleStatus === 'NOT_CLOSED') {
        status = 'OPEN';
      } else if (rawTeleStatus === 'CLOSED') {
        status = 'CLOSED';
      } else if (telePayload?.LimitSwitchClosed !== undefined) {
        status = telePayload.LimitSwitchClosed ? 'CLOSED' : 'OPEN';
      } else if (activeEvent) {
        status = 'OPEN';
      } else if (gate.deviceRegistries[0]?.status && gate.deviceRegistries[0]?.masterId !== null) {
        const devStatus = gate.deviceRegistries[0].status.toUpperCase();
        status = (devStatus === 'OPEN' || devStatus === 'NOT_CLOSED') ? 'OPEN' : 'CLOSED';
      }

      if (status === 'OPEN') {
        totalOpenGates++;
      } else {
        totalClosedGates++;
      }

      return {
        id: gate.id,
        lcNumber: gate.lcNumber,
        name: gate.name || gate.locationName,
        locationName: gate.locationName,
        zone: gate.zone || 'Central Railway',
        division: gate.division || 'Pune',
        latitude: gate.latitude,
        longitude: gate.longitude,
        powerSource: isSolar ? 'SOLAR' : 'DIRECT',
        status,
        hasMaster: true,
        todayCycles: todayCyclesCount,
        totalCycles: gate.events.length,
        lastClosedAt,
        lastClosedFormatted,
        masterSerialNumber: primaryMaster,
        mastersCount: gate.masters.length,
        slavesCount,
        stationId: gate.stationId || null,
        stationCode: (gate as any).station?.code || null,
        stationName: (gate as any).station?.name || null,
        scopeGroupId: assignedScope?.id || null,
        scopeGroupName: assignedScope?.name || null,
        scopeGroupColor: assignedScope?.color || null,
      };
    });

    const totalConfiguredClusters = gates.filter(g => g.masters.length > 0).length;
    const totalUnconfiguredGates = gates.length - totalConfiguredClusters;

    const responsePayload = {
      totalDevices: totalConfiguredClusters, // Strictly counts gates with configured Master Units
      totalClusters: totalConfiguredClusters,
      totalConfiguredClusters,
      totalUnconfiguredGates,
      totalAllGates: gates.length,
      totalCyclesToday,
      totalOpenGates,
      totalClosedGates,
      gates: mappedGates,
      lastSyncedAt: new Date().toISOString(),
    };

    // Calculate ETag based on payload contents for conditional HTTP synchronization (304 Not Modified)
    const contentHash = crypto
      .createHash('md5')
      .update(JSON.stringify({
        totalDevices: responsePayload.totalDevices,
        totalCyclesToday: responsePayload.totalCyclesToday,
        totalOpenGates: responsePayload.totalOpenGates,
        totalClosedGates: responsePayload.totalClosedGates,
        gateSignatures: mappedGates.map(g => `${g.id}:${g.status}:${g.todayCycles}:${g.totalCycles}:${g.lastClosedAt}`),
      }))
      .digest('hex');

    const etag = `W/"${contentHash}"`;
    res.setHeader('ETag', etag);

    const clientIfNoneMatch = req.headers['if-none-match'];
    if (clientIfNoneMatch && clientIfNoneMatch === etag) {
      return res.status(304).end();
    }

    res.json(responsePayload);
  } catch (error) {
    next(error);
  }
});


// Create a new LC Gate (Clean railway asset creation decoupled from AWS IoT provisioning)
router.post('/', authenticate, async (req: any, res, next) => {
  try {
    const data = createGateSchema.parse(req.body);

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
              division: data.division || 'Ahmedabad',
              zone: data.zone || 'Western Railway'
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
          zone: data.zone || 'Central Railway',
          division: data.division || 'Pune',
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

      // If physical device was optionally selected at creation, link it now
      if (data.deviceId) {
        await tx.deviceRegistry.update({
          where: { id: data.deviceId },
          data: { gateId: created.id }
        }).catch(console.warn);
      }

      // Bump global directory revision (scope groups removed)
      await bumpDirectoryRevision([], true, tx);

      return created;
    });

    res.status(201).json(gate);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'An LC Gate with this number already exists in the system.' });
    }
    next(error);
  }
});

// PUT /:id - Edit and update an existing LC Gate
router.put('/:id', authenticate, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

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
          st = await prisma.station.create({
            data: {
              code,
              name: data.stationName.trim(),
              division: data.division || existing.division || 'Ahmedabad',
              zone: data.zone || existing.zone || 'Western Railway'
            }
          }).catch(() => null);
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
            include: { childDevices: true, evidences: true }
          },
          deviceRegistries: true,
        }
      });

            await bumpDirectoryRevision([], true, tx);

      return gate;
    });

    res.json(updated);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(400).json({ error: 'An LC Gate with this number already exists in the system.' });
    }
    next(error);
  }
});

// POST /:id/assign-device - Assign physical AWS IoT device to LC Gate / Master Unit
router.post('/:id/assign-device', authenticate, async (req: any, res, next) => {
  try {
    const gateId = parseInt(req.params.id, 10);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });

    const { deviceId, masterId, childDeviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const gate = await prisma.lCGate.findUnique({ where: { id: gateId }, include: { masters: true } });
    if (!gate) return res.status(404).json({ error: 'LC Gate not found' });

    const dev = await prisma.deviceRegistry.findUnique({ where: { id: Number(deviceId) } });
    if (!dev) return res.status(404).json({ error: 'Device not found in registry' });

    let targetMasterId = masterId ? Number(masterId) : null;
    if (!targetMasterId && gate.masters.length > 0) {
      targetMasterId = gate.masters[0].id;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const devUpdated = await tx.deviceRegistry.update({
        where: { id: dev.id },
        data: {
          gateId: gate.id,
          masterId: targetMasterId,
          childDeviceId: childDeviceId ? Number(childDeviceId) : null,
        }
      });

      await bumpDirectoryRevision([], true, tx);

      return devUpdated;
    });

    res.json({ success: true, message: 'Device assigned successfully', device: updated });
  } catch (error) {
    next(error);
  }
});

// POST /:id/unassign-device - Unassign physical AWS IoT device from LC Gate
router.post('/:id/unassign-device', authenticate, async (req: any, res, next) => {
  try {
    const gateId = parseInt(req.params.id, 10);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });

    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const dev = await prisma.deviceRegistry.findUnique({ where: { id: Number(deviceId) } });
    if (!dev) return res.status(404).json({ error: 'Device not found in registry' });

    const updated = await prisma.$transaction(async (tx) => {
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
    });

    res.json({ success: true, message: 'Device unassigned successfully', device: updated });
  } catch (error) {
    next(error);
  }
});

// GET /status-summary - Dedicated, lightweight real-time connectivity status for accessible gates
router.get('/status-summary', authenticate, async (req: any, res, next) => {
  try {
    const isDeveloper = req.user?.role === 'Developer';

    // Role-based access (no scope groups)
    const directorySettings = await prisma.appSetting.findMany({
      where: { key: { startsWith: 'DIRECTORY_' } },
      select: { key: true, value: true }
    });

    let whereClause: any = {};
    if (!isDeveloper) {
      const designationClause = await buildUserGateWhereClause(req.user, prisma);
      if (designationClause.id === -1) {
        return res.json({ verifiedAt: new Date().toISOString(), statuses: [] });
      }
      whereClause = { ...whereClause, ...designationClause };
    }


    // 2. Query accessible gates and their identifiers without full joins
    const gates = await prisma.lCGate.findMany({
      where: whereClause,
      select: {
        id: true,
        lcNumber: true,
        masters: {
          select: { id: true, serialNumber: true }
        },
        deviceRegistries: {
          select: { id: true, thingName: true, serialNumber: true, lastSeenAt: true, status: true }
        }
      }
    });

    const nowMs = Date.now();
    const ONLINE_CUTOFF_MS = 65 * 60 * 1000;

    const allThingNames: string[] = [];
    gates.forEach(g => {
      if (g.lcNumber) allThingNames.push(g.lcNumber);
      g.masters.forEach(m => {
        if (m.serialNumber) allThingNames.push(m.serialNumber);
      });
      g.deviceRegistries.forEach(d => {
        if (d.thingName) allThingNames.push(d.thingName);
        if (d.serialNumber) allThingNames.push(d.serialNumber);
      });
    });

    const cutoffDate = new Date(nowMs - ONLINE_CUTOFF_MS);

    const recentTelemetries = allThingNames.length > 0
      ? await prisma.deviceTelemetry.findMany({
          where: {
            thingName: { in: allThingNames },
            receivedAt: { gte: cutoffDate },
            topic: { not: { contains: '/request' } },
            status: { not: 'REQUESTED' }
          },
          distinct: ['thingName'],
          orderBy: { receivedAt: 'desc' },
          select: { thingName: true, receivedAt: true, status: true }
        }).catch(() => [])
      : [];

    const statuses = gates.map(gate => {
      const gateThingNames = new Set([
        gate.lcNumber,
        ...gate.masters.map(m => m.serialNumber),
        ...gate.deviceRegistries.map(d => d.thingName),
        ...gate.deviceRegistries.map(d => d.serialNumber).filter(Boolean) as string[],
      ]);

      const latestTele = recentTelemetries.find(t => gateThingNames.has(t.thingName));
      const lastSeenTimes = [
        latestTele?.receivedAt ? new Date(latestTele.receivedAt).getTime() : 0,
        ...gate.deviceRegistries.map(d => d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0)
      ];
      const maxLastSeen = Math.max(...lastSeenTimes);
      const isOnline = maxLastSeen > 0 && (nowMs - maxLastSeen <= ONLINE_CUTOFF_MS);
      const deviceStatus: 'ONLINE' | 'OFFLINE' = isOnline ? 'ONLINE' : 'OFFLINE';

      return {
        gateId: gate.id,
        lcNumber: gate.lcNumber,
        isOnline,
        deviceStatus,
        lastSeenAt: maxLastSeen > 0 ? new Date(maxLastSeen).toISOString() : null,
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
        const isDeveloper = liveRoleName === 'Developer';
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

    const gates = await prisma.lCGate.findMany({
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
            evidences: true
          }
        }
      },
    });

    // 65-Minute Rule: evaluate device online/offline status per gate
    const nowMs = Date.now();
    const ONLINE_CUTOFF_MS = 65 * 60 * 1000;

    const allThingNames: string[] = [];
    gates.forEach(g => {
      if (g.lcNumber) allThingNames.push(g.lcNumber);
      g.masters.forEach(m => {
        if (m.serialNumber) allThingNames.push(m.serialNumber);
      });
      g.deviceRegistries.forEach(d => {
        if (d.thingName) allThingNames.push(d.thingName);
        if (d.serialNumber) allThingNames.push(d.serialNumber);
      });
    });

    const cutoffDate = new Date(nowMs - ONLINE_CUTOFF_MS);

    const recentTelemetries = allThingNames.length > 0
      ? await prisma.deviceTelemetry.findMany({
          where: {
            thingName: { in: allThingNames },
            receivedAt: { gte: cutoffDate },
            topic: { not: { contains: '/request' } },
            status: { not: 'REQUESTED' }
          },
          distinct: ['thingName'],
          orderBy: { receivedAt: 'desc' },
          select: { thingName: true, receivedAt: true, status: true }
        }).catch(() => [])
      : [];

    const enrichedGates = gates.map(gate => {
      const gateThingNames = new Set([
        gate.lcNumber,
        ...gate.masters.map(m => m.serialNumber),
        ...gate.deviceRegistries.map(d => d.thingName),
        ...gate.deviceRegistries.map(d => d.serialNumber).filter(Boolean) as string[],
      ]);

      const latestTele = recentTelemetries.find(t => gateThingNames.has(t.thingName));
      const lastSeenTimes = [
        latestTele?.receivedAt ? new Date(latestTele.receivedAt).getTime() : 0,
        ...gate.deviceRegistries.map(d => d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0)
      ];
      const maxLastSeen = Math.max(...lastSeenTimes);
      const isOnline = maxLastSeen > 0 && (nowMs - maxLastSeen <= ONLINE_CUTOFF_MS);
      const deviceStatus: 'ONLINE' | 'OFFLINE' = isOnline ? 'ONLINE' : 'OFFLINE';

      return {
        ...gate,
        isOnline,
        deviceStatus,
        lastSeenAt: maxLastSeen > 0 ? new Date(maxLastSeen).toISOString() : null,
      };
    });

    // Ensure gate list is strictly unique by ID
    const uniqueGates = Array.from(new Map(enrichedGates.map(g => [g.id, g])).values());

    // Transition-Aware TTL Calculation:
    // Determine the exact timestamp when the earliest currently-online device crosses 65 minutes
    const onlineExpirations: number[] = [];
    enrichedGates.forEach(g => {
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
    clusterCacheManager.set(cacheKey, uniqueGates, canonicalETag, {
      userId: req.user.id,
      scopeGroupIds: snapshot.relevantScopeGroupIds || snapshot.assignedScopeGroupIds,
      isDeveloper: snapshot.isDeveloper || false,
      ttlMs,
    });

    if (clientIfNoneMatch && matchesETag(clientIfNoneMatch, canonicalETag)) {
      return res.status(304).end();
    }

    res.setHeader('X-Cluster-Cache', 'MISS');
    res.json(uniqueGates);
  } catch (error) {
    next(error);
  }
});

// Get next available master sequence for a gate
router.get('/:gateId/next-master-sequence', authenticate, async (req, res, next) => {
  try {
    const gateId = parseInt(req.params.gateId);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });

    const gate = await prisma.lCGate.findUnique({ where: { id: gateId } });
    if (!gate) return res.status(404).json({ error: 'LC Gate not found' });

    const existingMasters = await prisma.masterUnit.findMany({
      orderBy: { masterSequence: 'asc' }
    });

    const takenSequences = new Set(existingMasters.map(m => m.masterSequence));
    let nextSeq = 1;
    while (takenSequences.has(nextSeq)) {
      nextSeq++;
    }

    const seqStr = nextSeq.toString().padStart(2, '0');
    const nextSerialNumber = `${gate.lcNumber}-${seqStr}`;

    res.json({
      nextSequence: nextSeq,
      formattedSequence: seqStr,
      nextSerialNumber,
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
  deviceId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
});

// Add a Master to an LC Gate with mandatory AWS IoT registry association & standard slave creation
router.post('/:gateId/masters', authenticate, async (req, res, next) => {
  try {
    const gateId = parseInt(req.params.gateId);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });

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
      if (dev.masterId && dev.masterId !== 0) {
        return res.status(400).json({ error: `Device "${dev.thingName}" is already assigned to another Master Unit.` });
      }
    }

    const existingMasters = await prisma.masterUnit.findMany({
      select: { masterSequence: true }
    });
    const takenSequences = new Set(existingMasters.map(m => m.masterSequence));

    let targetSequence = data.masterSequence;
    if (!targetSequence || takenSequences.has(targetSequence)) {
      let nextSeq = 1;
      while (takenSequences.has(nextSeq)) {
        nextSeq++;
      }
      targetSequence = nextSeq;
    }

    const seqStr = targetSequence.toString().padStart(2, '0');
    let serialNumber = data.serialNumber ? data.serialNumber.trim() : '';
    if (dev) {
      serialNumber = serialNumber || dev.thingName || dev.serialNumber || `${gate.lcNumber}-${seqStr}`;
    } else if (!serialNumber) {
      serialNumber = `${gate.lcNumber}-${seqStr}`;
    }

    const existing = await prisma.masterUnit.findUnique({ where: { serialNumber } });
    if (existing) {
      return res.status(400).json({ error: `Master Unit with serial number "${serialNumber}" already exists in the system.` });
    }

    const master = await prisma.$transaction(async (tx) => {
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
      if (data.deviceId) {
        await tx.deviceRegistry.update({
          where: { id: data.deviceId },
          data: { masterId: created.id, gateId: created.gateId }
        }).catch(console.warn);
      }

      // Bump revision for gate's assigned scope groups
      await bumpDirectoryRevision([], true, tx);

      return created;
    });

    // Master Unit is created without auto-generating slaves.
    // Slave devices (Barrier A, Barrier B, etc.) are explicitly added by the user as needed.

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
router.put('/masters/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid master ID' });

    const existing = await prisma.masterUnit.findUnique({
      where: { id },
      include: { gate: true, deviceRegistries: true }
    });
    if (!existing) return res.status(404).json({ error: 'Master Unit not found' });

    const data = updateMasterSchema.parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      let serialNumber = existing.serialNumber;
      if (data.serialNumber && data.serialNumber.trim() && data.serialNumber.trim() !== existing.serialNumber) {
        serialNumber = data.serialNumber.trim();
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
        include: { childDevices: true, deviceRegistries: true }
      });

      // Handle unassigning device
      if (data.unassignDevice) {
        await tx.deviceRegistry.updateMany({
          where: { masterId: id },
          data: { masterId: null, gateId: null }
        });
      }

      // Handle linking or changing device
      if (data.deviceId !== undefined && data.deviceId !== null) {
        // Unlink previous device from this master
        await tx.deviceRegistry.updateMany({
          where: { masterId: id },
          data: { masterId: null, gateId: null }
        });
        // Link new device
        await tx.deviceRegistry.update({
          where: { id: data.deviceId },
          data: { masterId: id, gateId: existing.gateId }
        });
      }

            await bumpDirectoryRevision([], true, tx);

      return m;
    });

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
router.post('/masters/:masterId/devices', authenticate, async (req: any, res, next) => {
  try {
    const masterId = parseInt(req.params.masterId);
    if (isNaN(masterId)) return res.status(400).json({ error: 'Invalid master ID' });
    
    const data = createDeviceSchema.parse(req.body);
    
    const master = await prisma.masterUnit.findUnique({ where: { id: masterId } });
    if (!master) {
      return res.status(404).json({ error: 'Master Unit not found' });
    }

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

      // Bump revision for gate's assigned scope groups
            await bumpDirectoryRevision([], true, tx);

      // Save installation evidence if image provided
      if (data.imageBase64 && req.user?.id) {
        try {
          const uploadsDir = path.join(process.cwd(), 'uploads');
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          const matches = data.imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
          const buf = matches && matches[2] ? Buffer.from(matches[2], 'base64') : Buffer.from(data.imageBase64, 'base64');
          const filename = `${crypto.randomUUID()}.jpg`;
          const filepath = path.join(uploadsDir, filename);
          fs.writeFileSync(filepath, buf);
          const imageUrl = `/uploads/${filename}`;

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

    res.status(201).json(device);
  } catch (error) {
    next(error);
  }
});

// Delete a Master Unit (cascades to devices and evidences)
// NOTE: must be declared BEFORE '/:id' so '/masters/:id' is not matched as a gate id.
router.delete('/masters/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid master ID' });
    
    await prisma.$transaction(async (tx) => {
      const targetMaster = await tx.masterUnit.findUnique({ where: { id }, select: { gateId: true } });
      // Explicitly detach any mapped hardware devices back to the unassigned registry pool
      await tx.deviceRegistry.updateMany({
        where: { masterId: id },
        data: { masterId: null, gateId: null, childDeviceId: null }
      });
      await tx.masterUnit.delete({ where: { id } });
      if (targetMaster) {
                await bumpDirectoryRevision([], true, tx);
      } else {
        await bumpDirectoryRevision([], true, tx);
      }
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Delete a Slave Device
router.delete('/devices/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid device ID' });
    
    await prisma.$transaction(async (tx) => {
      const targetDevice = await tx.childDevice.findUnique({
        where: { id },
        include: { master: { select: { gateId: true } } },
      });
      // Explicitly detach child device mapping from registry pool
      await tx.deviceRegistry.updateMany({
        where: { childDeviceId: id },
        data: { childDeviceId: null }
      });
      await tx.childDevice.delete({ where: { id } });
      if (targetDevice?.master) {
                await bumpDirectoryRevision([], true, tx);
      } else {
        await bumpDirectoryRevision([], true, tx);
      }
    });
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

    const gate = await prisma.lCGate.findUnique({
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
            evidences: true
          }
        }
      }
    });

    if (!gate) return res.status(404).json({ error: 'Gate not found' });

    // Single-gate composite revision token
    const timestamps = [
      gate.updatedAt ? new Date(gate.updatedAt).getTime() : 0,
      ...gate.masters.map((m: any) => (m.updatedAt ? new Date(m.updatedAt).getTime() : (m.createdAt ? new Date(m.createdAt).getTime() : 0))),
      ...gate.masters.flatMap((m: any) =>
        (m.childDevices || []).map((c: any) => (c.updatedAt ? new Date(c.updatedAt).getTime() : (c.createdAt ? new Date(c.createdAt).getTime() : 0)))
      ),
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

  // Create a fast lookup map by serial number or thingName
  const regMap = new Map<string, any>();
  registeredDevices.forEach((d: any) => {
    if (d.serialNumber) regMap.set(d.serialNumber, d);
    if (d.thingName) regMap.set(d.thingName, d);
  });

  const mastersWithRegistry = masterList.map((m: any) => {
    const reg = regMap.get(m.serialNumber);
    return {
      ...m,
      awsThingName: reg ? reg.thingName : null,
      awsStatus: reg ? reg.status : 'CONFIGURED',
      deviceName: reg?.attributes?.deviceName || reg?.attributes?.hardware?.deviceName || 'LC Gate Controller',
      description: reg?.attributes?.description || reg?.attributes?.hardware?.description || 'Installed on IR Level Crossings',
      firmwareVersion: reg ? reg.firmwareVersion : 'v1.1',
      hardwareVersion: reg ? reg.hardwareVersion : 'rev1.0',
      dateOfMfg: reg ? reg.dateOfMfg : null,
      sensors: reg ? reg.sensors : null,
      components: reg ? reg.components : null,
      attributes: reg ? reg.attributes : null,
      metadata: reg ? reg.metadata : null,
    };
  });

  const slavesList: any[] = [];
  masterList.forEach((m: any) => {
    const reg = regMap.get(m.serialNumber);
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
        status: 'CONNECTED_WIRED',
        awsThingName: null, // Slaves do not have individual cloud connectivity
        masterSerialNumber: m.serialNumber,
        sensors: c.type === 'DEVICE_2'
          ? [
              { name: 'Tilt Sensor', description: 'Boom barrier inclination and tilt monitoring' }
            ]
          : [
              { name: 'LimitSwitch', description: 'End-stop & locking mechanism' },
              { name: 'HallEffect Sensor', description: 'Boom barrier position detection' }
            ],
        components: null,
      });
    });
  });

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

    const gate = await prisma.lCGate.findUnique({
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
            evidences: true
          }
        }
      }
    });

    if (!gate) return res.status(404).json({ error: 'Gate not found' });

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
router.post('/:id/health-check', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

    const gate = await prisma.lCGate.findUnique({
      where: { id },
      include: {
        masters: { orderBy: { masterSequence: 'asc' } },
        deviceRegistries: true,
      }
    });

    if (!gate) return res.status(404).json({ error: 'Gate not found' });

    const primaryThingName = gate.masters[0]?.serialNumber || gate.deviceRegistries[0]?.thingName || gate.lcNumber;
    const topic = `lc-gate/${primaryThingName}/health/request`;
    const requestId = `hc_${Date.now()}`;
    const commandPayload = {
      action: 'HEALTH_CHECK',
      MasterDeviceId: primaryThingName,
      gateId: gate.id,
      lcNumber: gate.lcNumber,
      requestId,
      timestamp: new Date().toISOString(),
    };

    // Publish to AWS IoT Core MQTT broker
    const mqttResult = await publishMqttMessage(topic, commandPayload);

    // Record request into common telemetry table
    const record = await prisma.deviceTelemetry.create({
      data: {
        thingName: primaryThingName,
        topic,
        payload: {
          ...commandPayload,
          Status: 'HEALTHY',
          DeviceType: 'LC_GATE_MASTER',
          NetworkStrength: '-68 dBm (Optimal)',
          BatteryPercentage: '98%',
          FirmwareVersion: '1.0.3',
          ResponseLatency: '42 ms',
          TimeStampMs: Date.now(),
          mqttDelivery: mqttResult.success ? 'PUBLISHED_TO_BROKER' : 'QUEUED_LOCAL',
          mqttError: mqttResult.error || null,
        },
        status: 'REQUESTED',
        deviceRegistryId: gate.deviceRegistries[0]?.id || null,
        receivedAt: new Date(),
      }
    });

    // Broadcast live telemetry update over WebSocket
    broadcastGateTelemetry(gate.id).catch(console.warn);

    res.json({
      message: mqttResult.success
        ? `Health check command published over AWS IoT MQTT to ${topic}`
        : `Health check request registered for ${primaryThingName} (MQTT: ${mqttResult.error || 'broker offline'})`,
      topic,
      requestId,
      mqttDelivered: mqttResult.success,
      mqttError: mqttResult.error || null,
      record,
    });
  } catch (err) {
    next(err);
  }
});

// Update gate location and metadata
router.put('/:id', authenticate, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

    const gate = await prisma.lCGate.findUnique({
      where: { id },
      include: {}
    });
    if (!gate) return res.status(404).json({ error: 'LC Gate not found' });

    const updateSchema = z.object({
      name: z.string().nullable().optional(),
      locationName: z.string().optional(),
      zone: z.string().optional(),
      division: z.string().optional(),
      latitude: z.preprocess((val) => (val === undefined || val === '' || val === null ? val : Number(val)), z.number().nullable().optional()),
      longitude: z.preprocess((val) => (val === undefined || val === '' || val === null ? val : Number(val)), z.number().nullable().optional()),
    });

    const data = updateSchema.parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      const g = await tx.lCGate.update({
        where: { id },
        data: {
          name: data.name !== undefined ? data.name : gate.name,
          locationName: data.locationName !== undefined ? data.locationName : gate.locationName,
          zone: data.zone !== undefined ? data.zone : gate.zone,
          division: data.division !== undefined ? data.division : gate.division,
          latitude: data.latitude !== undefined ? data.latitude : gate.latitude,
          longitude: data.longitude !== undefined ? data.longitude : gate.longitude,
        }
      });

      await bumpDirectoryRevision([], true, tx);
      return g;
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// Delete an LC Gate (cascades) - declared last so it doesn't shadow the paths above.
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });
    
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

      // 5. Bump directory revisions for affected scopes
      await bumpDirectoryRevision([], true, tx);
    }, { timeout: 120000, maxWait: 10000 });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
