import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { publishMqttMessage } from '../lib/iotClient';
import { checkAndDispatchGateStateAlert, checkAndDispatchGateStateEmailAlert } from '../lib/gateAlertSms';
import { recordGateTelemetryTransition } from '../lib/telemetryMonitor';
import { broadcastGateTelemetry } from '../lib/telemetryWs';
import { bumpDirectoryRevision } from '../lib/revisionManager';
import { clusterCacheManager } from '../lib/clusterCacheManager';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadSimImage(base64Str: string): Promise<string> {
  const uploadsDir = path.join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  const buffer = (matches && matches.length === 3)
    ? Buffer.from(matches[2], 'base64')
    : Buffer.from(base64Str, 'base64');

  const filename = `${crypto.randomUUID()}.jpg`;
  const filepath = path.join(uploadsDir, filename);
  try {
    fs.writeFileSync(filepath, buffer);
  } catch (e) {
    console.warn('Local fs write failed for SIM photo:', e);
  }

  let imageUrl = `/uploads/${filename}`;
  try {
    const uploadResult = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Cloudinary SIM upload timed out after 8s'));
      }, 8000);

      const stream = cloudinary.uploader.upload_stream(
        { folder: 'lc-platform-evidence', resource_type: 'image' },
        (error, result) => {
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(buffer);
    });
    if (uploadResult?.secure_url) {
      imageUrl = uploadResult.secure_url;
    }
  } catch (cldErr) {
    console.warn('Cloudinary upload failed, falling back to local file URL:', cldErr);
  }
  return imageUrl;
}


const router = Router();

// Validation schema for creating or upserting a registered device
const registerDeviceSchema = z.object({
  thingName: z.string().min(1, 'Thing name is required').regex(/^LC-/i, 'Thing name must follow LC Gate standards and start with "LC-" (e.g. LC-M-001, LC-B-001)'),
  thingArn: z.string().optional().nullable(),
  thingTypeName: z.string().optional().nullable(),
  deviceType: z.string().default('MASTER'),
  serialNumber: z.string().optional().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PROVISIONED', 'DECOMMISSIONED', 'MAINTENANCE']).default('ACTIVE'),
  gateId: z.number().int().optional().nullable(),
  masterId: z.number().int().optional().nullable(),
  childDeviceId: z.number().int().optional().nullable(),
  macAddress: z.string().optional().nullable(),
  imei: z.string().optional().nullable(),
  firmwareVersion: z.string().optional().nullable(),
  hardwareVersion: z.string().optional().nullable(),
  dateOfMfg: z.preprocess((val) => (val ? new Date(val as string) : null), z.date().optional().nullable()),
  manufacturer: z.string().default('Mirtha / LC-Platform'),
  modelNumber: z.string().optional().nullable(),
  batchNumber: z.string().optional().nullable(),
  sensors: z.any().optional().nullable(),
  components: z.any().optional().nullable(),
  attributes: z.any().optional().nullable(),
  metadata: z.any().optional().nullable(),
  // SIM & Connectivity fields
  simPhotoUrl: z.string().optional().nullable(),
  simProvider: z.string().optional().nullable(),
  simNumber: z.string().optional().nullable(),
  iccid: z.string().optional().nullable(),
  simType: z.string().optional().nullable(),
  lastRechargeDate: z.preprocess((val) => (val ? new Date(val as string) : null), z.date().optional().nullable()),
  validityExpiryDate: z.preprocess((val) => (val ? new Date(val as string) : null), z.date().optional().nullable()),
});

const updateDeviceSchema = registerDeviceSchema.partial();

/**
 * Helper to auto-link device to existing Gate, MasterUnit, or ChildDevice by Serial Number
 */
async function resolveGateAssociations(serialNumber?: string | null, gateId?: number | null, client: any = prisma) {
  if (!serialNumber && !gateId) return { gateId: null, masterId: null, childDeviceId: null };

  let resolvedGateId = gateId || null;
  let resolvedMasterId: number | null = null;
  let resolvedChildDeviceId: number | null = null;

  if (serialNumber) {
    // 1. Check if serial matches a Master Unit
    const master = await client.masterUnit.findUnique({
      where: { serialNumber },
      select: { id: true, gateId: true },
    });
    if (master) {
      resolvedMasterId = master.id;
      if (!resolvedGateId) resolvedGateId = master.gateId;
    }

    // 2. Check if serial matches a Child Device
    const child = await client.childDevice.findUnique({
      where: { serialNumber },
      include: { master: { select: { id: true, gateId: true } } },
    });
    if (child) {
      resolvedChildDeviceId = child.id;
      if (!resolvedMasterId) resolvedMasterId = child.master.id;
      if (!resolvedGateId) resolvedGateId = child.master.gateId;
    }

    // 3. Check if serial or prefix matches an LC Gate number (e.g., LC-0001)
    if (!resolvedGateId) {
      const gateMatch = await client.lCGate.findFirst({
        where: {
          lcNumber: {
            equals: serialNumber.split('-').slice(0, 2).join('-'), // "LC-0001"
          },
        },
      });
      if (gateMatch) resolvedGateId = gateMatch.id;
    }
  }

  // 4. If gateId is known (either provided or resolved) but master/child are not yet fully resolved:
  if (resolvedGateId) {
    const gateMasters = await client.masterUnit.findMany({
      where: { gateId: resolvedGateId },
      orderBy: { masterSequence: 'asc' },
    });

    if (gateMasters.length > 0) {
      const primaryMaster = gateMasters[0];

      if (serialNumber) {
        const isSlave = serialNumber.endsWith('-A') || serialNumber.endsWith('-B') ||
                        serialNumber.includes('-A') || serialNumber.includes('-B');

        if (isSlave) {
          resolvedMasterId = primaryMaster.id;
          let child = await client.childDevice.findUnique({
            where: { serialNumber },
          });

          if (!child) {
            const type = (serialNumber.endsWith('-B') || serialNumber.includes('-B')) ? 'DEVICE_2' : 'DEVICE_1';
            const count = await client.childDevice.count({ where: { masterId: primaryMaster.id, type } });
            child = await client.childDevice.create({
              data: {
                serialNumber,
                type,
                deviceSequence: count + 1,
                masterId: primaryMaster.id,
              },
            });
          }
          resolvedChildDeviceId = child.id;
        } else if (!resolvedMasterId) {
          resolvedMasterId = primaryMaster.id;
        }
      } else if (!resolvedMasterId) {
        resolvedMasterId = primaryMaster.id;
      }
    }
  }

  return {
    gateId: resolvedGateId,
    masterId: resolvedMasterId,
    childDeviceId: resolvedChildDeviceId,
  };
}

/**
 * Scopes device queries to LC Gate Platform devices only (starts with "LC-").
 * If the param is not numeric and does not start with "LC-", returns null (not found).
 */
function buildLcDeviceWhere(param: string) {
  if (!param) return null;
  const isNumeric = /^\d+$/.test(param);
  if (isNumeric) {
    return {
      id: parseInt(param, 10),
      thingName: { startsWith: 'LC-', mode: 'insensitive' as const },
    };
  }
  if (!param.toUpperCase().startsWith('LC-')) {
    return null;
  }
  return {
    thingName: param,
  };
}

/**
 * GET /api/v1/devices/stats/summary
 * Device registry metrics and totals
 */
router.get('/stats/summary', authenticate, async (_req, res, next) => {
  try {
    const baseWhere: any = {
      thingName: { startsWith: 'LC-', mode: 'insensitive' },
      deviceType: { not: 'SLAVE' },
    };

    const [total, active, provisioned, masters] = await Promise.all([
      prisma.deviceRegistry.count({ where: baseWhere }),
      prisma.deviceRegistry.count({ where: { ...baseWhere, status: 'ACTIVE' } }),
      prisma.deviceRegistry.count({ where: { ...baseWhere, status: 'PROVISIONED' } }),
      prisma.deviceRegistry.count({
        where: {
          thingName: { startsWith: 'LC-', mode: 'insensitive' },
          deviceType: { in: ['MASTER', 'master', 'LC_GATE_MASTER', 'GATE_MASTER', 'LC-GATE-MASTER', 'MASTER_UNIT', 'LC_MASTER'] },
        },
      }),
    ]);

    res.json({
      total,
      active,
      provisioned,
      masters,
      slaves: 0, // Slaves are wired to masters, not individual cloud things
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/devices
 * List registered devices with search and filters
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { search, deviceType, status, gateId, unassigned, page = '1', limit = '50' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const take = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const skip = (pageNum - 1) * take;

    // Strict LC Gate Platform isolation: only query devices starting with 'LC-'
    const where: any = {
      thingName: { startsWith: 'LC-', mode: 'insensitive' },
    };

    if (deviceType && typeof deviceType === 'string' && deviceType !== 'ALL') {
      if (deviceType.toUpperCase() === 'MASTER') {
        where.deviceType = {
          in: ['MASTER', 'master', 'LC_GATE_MASTER', 'GATE_MASTER', 'LC-GATE-MASTER', 'MASTER_UNIT', 'LC_MASTER']
        };
      } else {
        where.deviceType = deviceType;
      }
    } else if (!deviceType || deviceType !== 'ALL') {
      // By default, show Master IoT devices (slaves are wired to masters)
      where.deviceType = { not: 'SLAVE' };
    }

    if (status && typeof status === 'string' && status !== 'ALL') {
      if (status !== 'ONLINE' && status !== 'OFFLINE') {
        where.status = status;
      }
    }


    if (unassigned === 'true') {
      where.masterId = null;
    }

    if (gateId && typeof gateId === 'string') {
      const gid = parseInt(gateId, 10);
      if (!isNaN(gid)) where.gateId = gid;
    }

    if (search && typeof search === 'string' && search.trim() !== '') {
      const s = search.trim();
      where.AND = [
        { thingName: { startsWith: 'LC-', mode: 'insensitive' } },
        {
          OR: [
            { thingName: { contains: s, mode: 'insensitive' } },
            { serialNumber: { contains: s, mode: 'insensitive' } },
            { modelNumber: { contains: s, mode: 'insensitive' } },
            { manufacturer: { contains: s, mode: 'insensitive' } },
            { imei: { contains: s, mode: 'insensitive' } },
          ],
        },
      ];
      delete where.thingName;
    }

    const [devices, totalCount] = await Promise.all([
      prisma.deviceRegistry.findMany({
        where,
        skip,
        take,
        orderBy: { updatedAt: 'desc' },
        include: {
          gate: {
            select: {
              id: true,
              lcNumber: true,
              name: true,
              locationName: true,
              zone: true,
              division: true,
            },
          },
          master: {
            select: {
              id: true,
              serialNumber: true,
              masterSequence: true,
              powerSource: true,
            },
          },
          childDevice: {
            select: {
              id: true,
              serialNumber: true,
              type: true,
              deviceSequence: true,
            },
          },
        },
      }),
      prisma.deviceRegistry.count({ where }),
    ]);

    const now = Date.now();
    // 65-Minute Rule: 1 hour periodic heartbeat (3600s) + 5 min network grace period (300s) = 65 minutes (3,900,000 ms)
    const ONLINE_TIMEOUT_MS = 65 * 60 * 1000;

    const enrichedDevices = await Promise.all(devices.map(async (device) => {
      const latestTele = await prisma.deviceTelemetry.findFirst({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id },
            ...(device.serialNumber ? [{ thingName: device.serialNumber }] : [])
          ]
        },
        orderBy: { receivedAt: 'desc' }
      }).catch(() => null);

      const latestHealth = await prisma.deviceHealthCheck.findFirst({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id }
          ]
        },
        orderBy: { createdAt: 'desc' }
      }).catch(() => null);

      // Latest transmission timestamp across telemetry, health check, or device registry lastSeenAt
      const timestamps = [
        latestTele?.receivedAt ? new Date(latestTele.receivedAt).getTime() : 0,
        latestHealth?.createdAt ? new Date(latestHealth.createdAt).getTime() : 0,
        device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0,
      ];
      const maxTimestamp = Math.max(...timestamps);
      const lastTimestamp = maxTimestamp > 0 ? new Date(maxTimestamp) : null;

      const isOnline = Boolean(
        lastTimestamp &&
        (now - maxTimestamp <= ONLINE_TIMEOUT_MS) &&
        device.status !== 'DECOMMISSIONED' &&
        device.status !== 'INACTIVE'
      );

      let simPhotoUrl = (device as any).simPhotoUrl;
      if (!simPhotoUrl && device.masterId) {
        const simEvidence = await prisma.installationEvidence.findFirst({
          where: { masterId: device.masterId, category: 'SIM_CARD' },
          orderBy: { createdAt: 'desc' },
          select: { imageUrl: true },
        }).catch(() => null);
        if (simEvidence?.imageUrl) {
          simPhotoUrl = simEvidence.imageUrl;
        }
      }

      return {
        ...device,
        simPhotoUrl,
        computedStatus: isOnline ? 'ONLINE' : 'OFFLINE',
        latestPayloadSent: lastTimestamp ? lastTimestamp.toISOString() : null,
        latestTopic: latestTele?.topic || `lc-gate/${device.thingName}/telemetry`,
        latestPayload: latestTele?.payload || (device.metadata as any)?.rawPayload || null,
      };
    }));

    let finalDevices = enrichedDevices;
    if (status === 'ONLINE') {
      finalDevices = enrichedDevices.filter(d => d.computedStatus === 'ONLINE');
    } else if (status === 'OFFLINE') {
      finalDevices = enrichedDevices.filter(d => d.computedStatus === 'OFFLINE');
    }

    res.json({
      devices: finalDevices,
      pagination: {
        page: pageNum,
        limit: take,
        total: totalCount,
        totalPages: Math.ceil(totalCount / take),
      },
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/devices/:id/telemetry
 * Retrieve device-wise historic payloads from the common telemetry table (MQTT broker format)
 */
router.get('/:id/telemetry', authenticate, async (req, res, next) => {
  try {
    const param = req.params.id;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const device = await prisma.deviceRegistry.findFirst({
      where,
      include: {
        gate: {
          select: { id: true, lcNumber: true, name: true, locationName: true, zone: true, division: true }
        }
      }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const [telemetries, healthChecks] = await Promise.all([
      prisma.deviceTelemetry.findMany({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id },
            ...(device.serialNumber ? [{ thingName: device.serialNumber }] : [])
          ]
        },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }).catch(() => []),
      prisma.deviceHealthCheck.findMany({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id },
            ...(device.serialNumber ? [{ thingName: device.serialNumber }] : [])
          ]
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => [])
    ]);

    // Categorize payloads:
    // 1. Telemetry: strictly gate state telemetry (lc-gate/+/telemetry)
    // 2. Manifest: firmware hardware profile (lc/devices/+/manifest)
    // 3. Health Check: hardware diagnostic records
    const telemetryRecords = telemetries.filter(t =>
      (t.topic && t.topic.includes('/telemetry')) &&
      !(t.topic && t.topic.includes('/health')) &&
      !((t.payload as any)?.action === 'HEALTH_CHECK' || (t.payload as any)?.action === 'HEALTH_CHECK_RESPONSE')
    );

    const manifestRecords = telemetries.filter(t =>
      (t.topic && t.topic.includes('/manifest')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).thing !== undefined || (t.payload as any).Master !== undefined))
    );

    // Map healthChecks from dedicated table or legacy telemetry records
    const healthRecords = healthChecks.length > 0 ? healthChecks.map((h: any) => ({
      id: h.id,
      thingName: h.thingName,
      topic: `lc-gate/${h.thingName}/health`,
      payload: h.rawPayload,
      status: h.healthstatus || 'HEALTHY',
      receivedAt: h.createdAt,
      deviceRegistryId: h.deviceRegistryId,
      gateStatus: h.gateStatus,
      isDedicatedHealthCheck: true,
    })) : telemetries.filter(t =>
      (t.topic && t.topic.includes('/health')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK' || (t.payload as any).action === 'HEALTH_CHECK_RESPONSE' || (t.payload as any).healthstatus !== undefined))
    );

    const nowMs = Date.now();
    const ONLINE_CUTOFF_MS = 65 * 60 * 1000; // 65-Minute Rule
    const latestTimestamp = telemetryRecords[0]?.receivedAt || healthRecords[0]?.receivedAt || device.lastSeenAt || null;
    const isOnline = Boolean(
      latestTimestamp &&
      (nowMs - new Date(latestTimestamp).getTime() <= ONLINE_CUTOFF_MS) &&
      device.status !== 'DECOMMISSIONED' &&
      device.status !== 'INACTIVE'
    );
    const computedStatus = isOnline ? 'ONLINE' : 'OFFLINE';

    const latestTele = telemetryRecords[0]?.payload as any;
    // Physical Gate Status is always OPEN / CLOSED / NOT_CLOSED (never "HEALTHY")
    const rawTeleStatus = latestTele?.Status ? String(latestTele.Status).trim().toUpperCase() : null;
    const currentStatus = (rawTeleStatus === 'NOT_CLOSED' ? 'OPEN' : rawTeleStatus) || (latestTele?.LimitSwitchClosed !== undefined ? (latestTele.LimitSwitchClosed ? 'CLOSED' : 'OPEN') : (device.status === 'NOT_CLOSED' ? 'OPEN' : (device.status || 'UNKNOWN')));

    // Construct unified payload list without duplicates
    const seenUids = new Set<string>();
    const deduplicatedPayloads: any[] = [];
    
    // 1. Add dedicated health records first (if any)
    if (healthChecks.length > 0) {
      for (const h of healthRecords) {
        const uid = `hc-${h.id}`;
        if (!seenUids.has(uid)) {
          seenUids.add(uid);
          deduplicatedPayloads.push(h);
        }
      }
    }

    // 2. Add telemetry/manifest records (preventing any duplicate ID collision)
    for (const t of telemetries) {
      const uid = `tel-${t.id}`;
      if (!seenUids.has(uid)) {
        seenUids.add(uid);
        deduplicatedPayloads.push(t);
      }
    }
    deduplicatedPayloads.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());

    res.json({
      thingName: device.thingName,
      serialNumber: device.serialNumber,
      deviceType: device.deviceType,
      firmwareVersion: device.firmwareVersion,
      gate: device.gate,
      currentStatus,
      computedStatus,
      isOnline,
      lastSeenAt: latestTimestamp,
      counts: {
        all: deduplicatedPayloads.length,
        telemetry: telemetryRecords.length,
        manifest: manifestRecords.length,
        healthCheck: healthRecords.length,
      },
      latestTelemetry: telemetryRecords[0] || null,
      latestManifest: manifestRecords[0] || (device.metadata ? { topic: `lc/devices/${device.thingName}/manifest`, payload: (device.metadata as any).rawPayload || device.metadata, receivedAt: device.createdAt } : null),
      latestHealthCheck: healthRecords[0] || null,
      healthChecks: healthRecords,
      payloads: deduplicatedPayloads,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/devices/:id/health-checks
 * Dedicated endpoint for real-time edge device diagnostic history
 */
router.get(['/:id/health-checks', '/:thingName/health-checks'], authenticate, async (req, res, next) => {
  try {
    const param = req.params.id || req.params.thingName;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const device = await prisma.deviceRegistry.findFirst({
      where,
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const checks = await prisma.deviceHealthCheck.findMany({
      where: {
        OR: [
          { thingName: device.thingName },
          { deviceRegistryId: device.id },
          ...(device.serialNumber ? [{ thingName: device.serialNumber }] : [])
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      thingName: device.thingName,
      count: checks.length,
      latest: checks[0] || null,
      healthChecks: checks,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/v1/devices/:id
 * DELETE /api/v1/devices/:thingName
 * Deletes a device from the DeviceRegistry and cleans up telemetry/scope mappings.
 */
router.delete(['/:id', '/:thingName'], authenticate, async (req, res, next) => {
  try {
    const param = req.params.id || req.params.thingName;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const device = await prisma.deviceRegistry.findFirst({
      where,
      include: {
        gate: {
          select: { id: true, lcNumber: true, locationName: true }
        }
      }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const thingName = device.thingName;

    // 1. Delete associated telemetry and health check records
    await Promise.all([
      prisma.deviceTelemetry.deleteMany({
        where: {
          OR: [
            { thingName },
            { deviceRegistryId: device.id },
          ],
        },
      }).catch(console.warn),
      prisma.deviceHealthCheck.deleteMany({
        where: {
          OR: [
            { thingName },
            { deviceRegistryId: device.id },
          ],
        },
      }).catch(console.warn),
    ]);

    // 2. Delete from DeviceRegistry
    await prisma.deviceRegistry.delete({
      where: { id: device.id },
    });

    res.json({
      success: true,
      message: `Device ${thingName} deleted successfully from registry`,
      deletedDevice: {
        id: device.id,
        thingName: device.thingName,
        serialNumber: device.serialNumber,
        gate: device.gate,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/devices/:id/health-check
 * POST /api/v1/devices/:thingName/health-check
 * Triggers a health check command to the physical device over AWS IoT Core MQTT broker
 */
router.post(['/:id/health-check', '/:thingName/health-check'], authenticate, async (req, res, next) => {
  try {
    const param = req.params.id || req.params.thingName;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const device = await prisma.deviceRegistry.findFirst({
      where,
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const topic = `lc-gate/${device.thingName}/health/request`;
    const requestId = `hc_${Date.now()}`;
    const commandPayload = {
      action: 'HEALTH_CHECK',
      MasterDeviceId: device.thingName,
      requestId,
      timestamp: new Date().toISOString(),
    };

    // Publish to AWS IoT Core MQTT broker
    const mqttResult = await publishMqttMessage(topic, commandPayload);

    // Record request into common telemetry table so history tracks the health check trigger
    const record = await prisma.deviceTelemetry.create({
      data: {
        thingName: device.thingName,
        topic,
        payload: {
          ...commandPayload,
          mqttDelivery: mqttResult.success ? 'PUBLISHED_TO_BROKER' : 'QUEUED_LOCAL',
          mqttError: mqttResult.error || null,
        },
        status: 'REQUESTED',
        deviceRegistryId: device.id,
        receivedAt: new Date(),
      }
    });

    res.json({
      message: mqttResult.success
        ? `Health check command published over AWS IoT MQTT to ${topic}`
        : `Health check request registered for ${device.thingName} (MQTT: ${mqttResult.error || 'broker offline'})`,
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

/**
 * POST /api/v1/devices/telemetry
 * POST /api/v1/devices/:thingName/telemetry
 * Public webhook/endpoint for AWS IoT Core Rule HTTP Action, Lambda, edge devices, or simulator
 * to record real-world device payloads into the common telemetry table.
 */
router.post(['/telemetry', '/:thingName/telemetry'], async (req, res, next) => {
  try {
    const raw = req.body || {};
    const paramThing = req.params.thingName;

    // Detect thingName from parameter, payload body, or MQTT topic
    let thingName = paramThing || raw.MasterDeviceId || raw.thingName || raw.thing_name || raw.serialNumber || raw.serial_number || raw.deviceId;
    let topic = raw.topic;

    if (!thingName && topic) {
      const match = topic.match(/(?:devices|lc-gate)\/([^\/]+)/);
      if (match) thingName = match[1];
    }

    if (!thingName) {
      return res.status(400).json({ error: 'MasterDeviceId or thingName is required in telemetry body' });
    }

    // Default topic according to user's real-world topic format
    if (!topic) {
      if (raw.action === 'HEALTH_CHECK' || raw.action === 'HEALTH_CHECK_RESPONSE' || raw.healthstatus !== undefined || raw.BatteryPercentage !== undefined || raw.NetworkStrength !== undefined) {
        topic = `lc-gate/${thingName}/health`;
      } else if (raw.thing?.Master || raw.Master) {
        topic = `lc/devices/${thingName}/manifest`;
      } else {
        topic = `lc-gate/${thingName}/telemetry`;
      }
    }

    // Determine payload body
    const payload = raw.payload !== undefined ? raw.payload : raw;
    if (payload && typeof payload === 'object') {
      if (typeof payload.Status === 'string' && payload.Status.toUpperCase() === 'NOT_CLOSED') {
        payload.Status = 'OPEN';
      }
      if (typeof payload.status === 'string' && payload.status.toUpperCase() === 'NOT_CLOSED') {
        payload.status = 'OPEN';
      }
    }

    const statusVal = payload.Status || 'ONLINE';
    const fwVersion = payload.FirmwareVersion || payload.firmwareVersion || undefined;

    // Check if this incoming message is a health diagnostic report
    const isHealthTopic = String(topic).includes('/health') || payload.action === 'HEALTH_CHECK_RESPONSE' || payload.healthstatus !== undefined;
    const isHealthResponse = isHealthTopic && (payload.healthstatus !== undefined || payload.action === 'HEALTH_CHECK_RESPONSE' || payload.BoomAngle !== undefined);

    // Complete Atomic Telemetry & Heartbeat Persistence:
    // Wraps DeviceRegistry updates, atomic first-time provisioning, directory revision increments,
    // and DeviceTelemetry / DeviceHealthCheck writes in a unified atomic transaction.
    const heartbeatResult = await prisma.$transaction(async (tx) => {
      // 1. Row-level lock on existing device row
      // Deterministic priority ordering: exact thingName match takes precedence over serialNumber match,
      // preventing arbitrary device selection under conflicting identity fields.
      const lockedRows: any[] = await tx.$queryRaw`
        SELECT id, "thingName", "serialNumber", "gateId", "lastSeenAt", "firmwareVersion", "status"
        FROM "DeviceRegistry"
        WHERE "thingName" = ${thingName} OR "serialNumber" = ${thingName}
        ORDER BY CASE WHEN "thingName" = ${thingName} THEN 0 ELSE 1 END, id ASC
        LIMIT 1
        FOR UPDATE
      `;
      let dev = lockedRows.length > 0 ? lockedRows[0] : null;

      // 2. Detect if device was previously OFFLINE (>65m or never seen) before this heartbeat
      let wasOffline = false;

      if (!dev) {
        // Ingestion Guard: Only auto-provision devices matching the LC Gate platform naming convention ('LC-')
        if (!thingName.toUpperCase().startsWith('LC-')) {
          return { ignored: true, device: null, wasOffline: false, affectedScopeIds: [], isGlobal: false, telemetry: null, healthCheck: null, isHealthResponse: false, currentState: null, previousState: null };
        }

        const resolved = await resolveGateAssociations(thingName, null, tx);

        // Deterministic transaction-safe native upsert using PostgreSQL (xmax = 0)
        // (xmax = 0) evaluates to true if and only if PostgreSQL executed a fresh INSERT.
        // If a concurrent request already inserted the row, (xmax = 0) evaluates to false on conflict update.
        const insertedRows: any[] = await tx.$queryRaw`
          INSERT INTO "DeviceRegistry" (
            "thingName", "serialNumber", "status", "gateId", "masterId", "childDeviceId", "deviceType", "firmwareVersion", "lastSeenAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${thingName}, ${thingName}, 'ONLINE', ${resolved.gateId}, ${resolved.masterId}, ${resolved.childDeviceId},
            ${payload.DeviceType || 'MASTER'}, ${fwVersion || null}, NOW(), NOW(), NOW()
          )
          ON CONFLICT ("thingName") DO UPDATE
          SET "lastSeenAt" = NOW(),
              "status" = 'ONLINE',
              "firmwareVersion" = COALESCE(${fwVersion || null}, "DeviceRegistry"."firmwareVersion"),
              "updatedAt" = NOW()
          RETURNING id, "thingName", "serialNumber", "gateId", "lastSeenAt", "firmwareVersion", "status", (xmax = 0) AS is_inserted
        `;
        dev = insertedRows[0];
        // Deterministic check: only genuine first-time insertion triggers OFFLINE->ONLINE directory invalidation
        wasOffline = Boolean(dev.is_inserted);
      } else {
        wasOffline = !dev.lastSeenAt || (Date.now() - new Date(dev.lastSeenAt).getTime() > 65 * 60 * 1000);
        let gateIdToUpdate = dev.gateId;
        if (!gateIdToUpdate) {
          const resolved = await resolveGateAssociations(dev.serialNumber || dev.thingName, null, tx);
          gateIdToUpdate = resolved.gateId;
        }
        dev = await tx.deviceRegistry.update({
          where: { id: dev.id },
          data: {
            lastSeenAt: new Date(),
            status: 'ONLINE',
            firmwareVersion: fwVersion || dev.firmwareVersion,
            gateId: gateIdToUpdate || undefined,
          }
        });
      }

      // 3. If transition from OFFLINE to ONLINE occurred, atomically increment directory revisions within tx
      let affectedScopeIds: number[] = [];
      let isGlobal = false;
      if (wasOffline) {
        if (dev.gateId) {
          isGlobal = false;
          await bumpDirectoryRevision([], true, tx);
        } else {
          isGlobal = true;
          await bumpDirectoryRevision([], true, tx);
        }
      }

      // 4. Fetch previous telemetry within transaction to detect genuine gate state transitions (OPEN <-> CLOSED)
      const previousTele = await tx.deviceTelemetry.findFirst({
        where: {
          OR: [
            { thingName: dev.thingName },
            { deviceRegistryId: dev.id },
          ],
          topic: { contains: '/telemetry' },
        },
        orderBy: { receivedAt: 'desc' },
      });

      // 5. Parse current and previous reported gate status
      let currentState: 'OPEN' | 'CLOSED' | null = null;
      if (payload.Status !== undefined) {
        const s = String(payload.Status).trim().toUpperCase();
        if (s === 'CLOSED') currentState = 'CLOSED';
        else if (s === 'OPEN' || s === 'NOT_CLOSED') currentState = 'OPEN';
      } else if (payload.LimitSwitchClosed !== undefined) {
        currentState = payload.LimitSwitchClosed ? 'CLOSED' : 'OPEN';
      } else if (payload.status !== undefined) {
        const s = String(payload.status).trim().toUpperCase();
        if (s === 'CLOSED') currentState = 'CLOSED';
        else if (s === 'OPEN' || s === 'NOT_CLOSED') currentState = 'OPEN';
      }

      let previousState: 'OPEN' | 'CLOSED' | null = null;
      if (previousTele && previousTele.payload && typeof previousTele.payload === 'object') {
        const prevP = previousTele.payload as any;
        if (prevP.Status !== undefined) {
          const s = String(prevP.Status).trim().toUpperCase();
          if (s === 'CLOSED') previousState = 'CLOSED';
          else if (s === 'OPEN' || s === 'NOT_CLOSED') previousState = 'OPEN';
        } else if (prevP.LimitSwitchClosed !== undefined) {
          previousState = prevP.LimitSwitchClosed ? 'CLOSED' : 'OPEN';
        } else if (prevP.status !== undefined) {
          const s = String(prevP.status).trim().toUpperCase();
          if (s === 'CLOSED') previousState = 'CLOSED';
          else if (s === 'OPEN' || s === 'NOT_CLOSED') previousState = 'OPEN';
        }
      }

      // 6. Save telemetry record into DB within the SAME transaction
      let createdHealth: any = null;
      let createdTele: any = null;

      if (isHealthResponse) {
        createdHealth = await tx.deviceHealthCheck.create({
          data: {
            thingName: dev.thingName,
            requestId: payload.requestId || null,
            healthstatus: payload.healthstatus || 'HEALTHY',
            gateStatus: (payload.Status === 'NOT_CLOSED' ? 'OPEN' : payload.Status) || (payload.LimitSwitchClosed !== undefined ? (payload.LimitSwitchClosed ? 'CLOSED' : 'OPEN') : null),
            boomAngle: payload.BoomAngle !== undefined && payload.BoomAngle !== null ? parseFloat(payload.BoomAngle) : null,
            mcuTempC: payload.McuTempC !== undefined && payload.McuTempC !== null ? parseFloat(payload.McuTempC) : null,
            signalStrength: payload.SignalStrength !== undefined && payload.SignalStrength !== null ? parseInt(payload.SignalStrength) : null,
            networkType: payload.NetworkType || '4G_LTE',
            limitSwitchClosed: payload.LimitSwitchClosed !== undefined && payload.LimitSwitchClosed !== null ? Boolean(payload.LimitSwitchClosed) : null,
            hallClosed: payload.HallClosed !== undefined && payload.HallClosed !== null ? Boolean(payload.HallClosed) : null,
            batteryVoltage: payload.BatteryVoltage !== undefined && payload.BatteryVoltage !== null ? parseFloat(payload.BatteryVoltage) : null,
            batteryPercentage: payload.BatteryPercentage !== undefined && payload.BatteryPercentage !== null ? parseInt(payload.BatteryPercentage) : null,
            solarVoltage: payload.SolarVoltage !== undefined && payload.SolarVoltage !== null ? parseFloat(payload.SolarVoltage) : null,
            solarCharging: payload.SolarCharging !== undefined && payload.SolarCharging !== null ? Boolean(payload.SolarCharging) : null,
            uptimeSeconds: payload.UptimeSeconds !== undefined && payload.UptimeSeconds !== null ? parseInt(payload.UptimeSeconds) : null,
            firmwareVersion: payload.FirmwareVersion || fwVersion || '1.0.6',
            rawPayload: payload,
            deviceRegistryId: dev.id,
            createdAt: raw.timestamp ? new Date(raw.timestamp) : new Date(),
          }
        });
      } else {
        createdTele = await tx.deviceTelemetry.create({
          data: {
            thingName: dev.thingName,
            topic,
            payload,
            status: 'ONLINE',
            deviceRegistryId: dev.id,
            receivedAt: raw.timestamp ? new Date(raw.timestamp) : new Date(),
          }
        });
      }

      return {
        ignored: false,
        device: dev,
        wasOffline,
        affectedScopeIds,
        isGlobal,
        telemetry: createdTele,
        healthCheck: createdHealth,
        isHealthResponse,
        currentState,
        previousState,
      };
    });

    if (heartbeatResult.ignored) {
      return res.status(200).json({
        message: `Foreign telemetry ignored: thingName "${thingName}" does not belong to LC Platform (must start with "LC-")`
      });
    }

    const device = heartbeatResult.device!;
    const { telemetry, healthCheck, currentState, previousState } = heartbeatResult;

    // Invalidate local in-memory L1 cache after transaction commits
    if (heartbeatResult.wasOffline) {
      if (heartbeatResult.isGlobal || heartbeatResult.affectedScopeIds.length === 0) {
        clusterCacheManager.invalidateAll();
      } else {
        clusterCacheManager.invalidateAll();
      }
    }

    if (heartbeatResult.isHealthResponse) {
      return res.status(201).json({
        message: 'Health diagnostic report recorded in DeviceHealthCheck table',
        healthCheck,
        device: { id: device.id, thingName: device.thingName, status: 'ACTIVE' }
      });
    }

    // Trigger DLT SMS dispatch if state genuinely transitioned between OPEN and CLOSED
    if (currentState && previousState && currentState !== previousState && telemetry) {
      console.log(`⚡ [STATE TRANSITION DETECTED] Gate "${device.thingName}": ${previousState} ➔ ${currentState}`);
      checkAndDispatchGateStateAlert({
        deviceId: device.id,
        gateId: device.gateId,
        thingName: device.thingName,
        serialNumber: device.serialNumber,
        newState: currentState,
        timestamp: telemetry.receivedAt,
      }).catch(err => console.error('Error dispatching gate state SMS alert:', err));

      recordGateTelemetryTransition({
        gateId: device.gateId,
        thingName: device.thingName,
        newState: currentState,
        timestamp: telemetry.receivedAt,
      }).catch(err => console.error('Error recording telemetry event for reports:', err));
    }

    // Broadcast live telemetry update over WebSocket to any connected clients
    if (device.gateId) {
      broadcastGateTelemetry(device.gateId).catch(console.warn);
    }

    res.status(201).json({
      message: 'Payload ingested and recorded successfully',
      telemetry,
      stateTransition: (currentState && previousState && currentState !== previousState) ? {
        from: previousState,
        to: currentState,
        alertDispatched: true
      } : null,
      device: {
        id: device.id,
        thingName: device.thingName,
        status: 'ACTIVE',
        lastSeenAt: new Date(),
      }
    });


  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/devices/:id/test-sms-alert
 * Test endpoint to simulate a gate state change (OPEN or CLOSED) and test DLT SMS dispatch
 */
router.post('/:id/test-sms-alert', authenticate, async (req, res, next) => {
  try {
    const param = req.params.id;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const { state = 'OPEN' } = req.body;
    const targetState: 'OPEN' | 'CLOSED' = String(state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';

    const device = await prisma.deviceRegistry.findFirst({
      where,
      include: { gate: true }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const alertResult = await checkAndDispatchGateStateAlert({
      deviceId: device.id,
      gateId: device.gateId,
      thingName: device.thingName,
      serialNumber: device.serialNumber,
      newState: targetState,
      timestamp: new Date()
    });

    res.json({
      message: `Gate state change alert test triggered for ${targetState}`,
      device: { id: device.id, thingName: device.thingName, gate: device.gate },
      alertResult
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/devices/:id/test-email-alert
 * Test endpoint to simulate a gate state change (OPEN or CLOSED) and test Brevo email alert dispatch
 */
router.post('/:id/test-email-alert', authenticate, async (req, res, next) => {
  try {
    const param = req.params.id;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const { state = 'OPEN' } = req.body;
    const targetState: 'OPEN' | 'CLOSED' = String(state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';

    const device = await prisma.deviceRegistry.findFirst({
      where,
      include: { gate: true }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const emailAlertResult = await checkAndDispatchGateStateEmailAlert({
      deviceId: device.id,
      gateId: device.gateId,
      thingName: device.thingName,
      serialNumber: device.serialNumber,
      newState: targetState,
      timestamp: new Date()
    });

    res.json({
      message: `Gate state change email alert test triggered for ${targetState}`,
      device: { id: device.id, thingName: device.thingName, gate: device.gate },
      emailAlertResult
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/devices/:id/test-alert
 * Test endpoint to simulate a gate state change and test BOTH DLT SMS and Brevo Email dispatch
 */
router.post('/:id/test-alert', authenticate, async (req, res, next) => {
  try {
    const param = req.params.id;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found' });
    }
    const { state = 'OPEN' } = req.body;
    const targetState: 'OPEN' | 'CLOSED' = String(state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';

    const device = await prisma.deviceRegistry.findFirst({
      where,
      include: { gate: true }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const alertResult = await checkAndDispatchGateStateAlert({
      deviceId: device.id,
      gateId: device.gateId,
      thingName: device.thingName,
      serialNumber: device.serialNumber,
      newState: targetState,
      timestamp: new Date()
    });

    res.json({
      message: `Full dual-channel (SMS + Brevo Email) alert test triggered for ${targetState}`,
      device: { id: device.id, thingName: device.thingName, gate: device.gate },
      alertResult
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/devices/:id
 * Retrieve single device by ID or thingName
 */
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const param = req.params.id;
    const where = buildLcDeviceWhere(param);
    if (!where) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    const device = await prisma.deviceRegistry.findFirst({
      where,
      include: {
        gate: true,
        master: {
          include: {
            childDevices: true,
          },
        },
        childDevice: true,
      },
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    let simPhotoUrl = (device as any).simPhotoUrl;
    if (!simPhotoUrl && device.masterId) {
      const simEvidence = await prisma.installationEvidence.findFirst({
        where: { masterId: device.masterId, category: 'SIM_CARD' },
        orderBy: { createdAt: 'desc' },
        select: { imageUrl: true },
      }).catch(() => null);
      if (simEvidence?.imageUrl) {
        simPhotoUrl = simEvidence.imageUrl;
      }
    }

    res.json({
      ...device,
      simPhotoUrl,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/devices
 * Register or Upsert a device in the RDS Device Registry
 * Can be invoked directly by admin, backend, or webhook from AWS IoT
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const data = registerDeviceSchema.parse(req.body);

    // Auto-resolve relations if not explicitly provided
    const resolved = await resolveGateAssociations(data.serialNumber || data.thingName, data.gateId);

    const gateId = data.gateId !== undefined ? data.gateId : resolved.gateId;
    const masterId = data.masterId !== undefined ? data.masterId : resolved.masterId;
    const childDeviceId = data.childDeviceId !== undefined ? data.childDeviceId : resolved.childDeviceId;

    const device = await prisma.deviceRegistry.upsert({
      where: { thingName: data.thingName },
      create: {
        thingName: data.thingName,
        thingArn: data.thingArn,
        thingTypeName: data.thingTypeName,
        deviceType: data.deviceType,
        serialNumber: data.serialNumber || data.thingName,
        status: data.status,
        gateId,
        masterId,
        childDeviceId,
        macAddress: data.macAddress,
        imei: data.imei,
        firmwareVersion: data.firmwareVersion,
        hardwareVersion: data.hardwareVersion,
        dateOfMfg: data.dateOfMfg,
        manufacturer: data.manufacturer,
        modelNumber: data.modelNumber,
        batchNumber: data.batchNumber,
        sensors: data.sensors ? (typeof data.sensors === 'string' ? JSON.parse(data.sensors) : data.sensors) : null,
        components: data.components ? (typeof data.components === 'string' ? JSON.parse(data.components) : data.components) : null,
        attributes: data.attributes ? (typeof data.attributes === 'string' ? JSON.parse(data.attributes) : data.attributes) : null,
        metadata: data.metadata ? (typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata) : null,
        lastSeenAt: new Date(),
      },
      update: {
        thingArn: data.thingArn !== undefined ? data.thingArn : undefined,
        thingTypeName: data.thingTypeName !== undefined ? data.thingTypeName : undefined,
        deviceType: data.deviceType,
        serialNumber: data.serialNumber !== undefined ? data.serialNumber : undefined,
        status: data.status,
        gateId: gateId !== undefined ? gateId : undefined,
        masterId: masterId !== undefined ? masterId : undefined,
        childDeviceId: childDeviceId !== undefined ? childDeviceId : undefined,
        macAddress: data.macAddress !== undefined ? data.macAddress : undefined,
        imei: data.imei !== undefined ? data.imei : undefined,
        firmwareVersion: data.firmwareVersion !== undefined ? data.firmwareVersion : undefined,
        hardwareVersion: data.hardwareVersion !== undefined ? data.hardwareVersion : undefined,
        dateOfMfg: data.dateOfMfg !== undefined ? data.dateOfMfg : undefined,
        manufacturer: data.manufacturer !== undefined ? data.manufacturer : undefined,
        modelNumber: data.modelNumber !== undefined ? data.modelNumber : undefined,
        batchNumber: data.batchNumber !== undefined ? data.batchNumber : undefined,
        sensors: data.sensors ? (typeof data.sensors === 'string' ? JSON.parse(data.sensors) : data.sensors) : undefined,
        components: data.components ? (typeof data.components === 'string' ? JSON.parse(data.components) : data.components) : undefined,
        attributes: data.attributes ? (typeof data.attributes === 'string' ? JSON.parse(data.attributes) : data.attributes) : undefined,
        metadata: data.metadata ? (typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata) : undefined,
        lastSeenAt: new Date(),
      },
      include: {
        gate: true,
        master: true,
        childDevice: true,
      },
    });

    res.status(201).json({
      message: 'Device successfully registered in RDS device registry',
      device,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/v1/devices/:id
 * Update metadata, sensors, components, or status of a registered device
 */
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid device ID' });

    const data = updateDeviceSchema.parse(req.body);

    const existing = await prisma.deviceRegistry.findFirst({
      where: {
        id,
        thingName: { startsWith: 'LC-', mode: 'insensitive' },
      },
    });
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    let masterId = data.masterId;
    let childDeviceId = data.childDeviceId;

    if (data.gateId !== undefined) {
      if (data.gateId === null) {
        masterId = null;
        childDeviceId = null;
      } else if (masterId === undefined && childDeviceId === undefined) {
        const resolved = await resolveGateAssociations(existing.serialNumber || existing.thingName, data.gateId);
        masterId = resolved.masterId;
        childDeviceId = resolved.childDeviceId;
      }
    }

    const updated = await prisma.deviceRegistry.update({
      where: { id },
      data: {
        ...data,
        gateId: data.gateId !== undefined ? data.gateId : undefined,
        masterId: masterId !== undefined ? masterId : undefined,
        childDeviceId: childDeviceId !== undefined ? childDeviceId : undefined,
        sensors: data.sensors ? (typeof data.sensors === 'string' ? JSON.parse(data.sensors) : data.sensors) : undefined,
        components: data.components ? (typeof data.components === 'string' ? JSON.parse(data.components) : data.components) : undefined,
        attributes: data.attributes ? (typeof data.attributes === 'string' ? JSON.parse(data.attributes) : data.attributes) : undefined,
        metadata: data.metadata ? (typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata) : undefined,
      },
      include: {
        gate: true,
        master: true,
        childDevice: true,
      },
    });

    // Invalidate Cluster cache if device assignment changed or belongs to a gate
    const affectedGateIds = [existing.gateId, updated.gateId].filter((gid): gid is number => typeof gid === 'number');
    if (affectedGateIds.length > 0) {
      await bumpDirectoryRevision([], true);
    }

    res.json({
      message: 'Device registry updated successfully',
      device: updated,
    });
  } catch (error) {
    next(error);
  }
});

const simUpdateSchema = z.object({
  imageBase64: z.string().optional().nullable(),
  simPhotoUrl: z.string().optional().nullable(),
  simProvider: z.string().optional().nullable(),
  simNumber: z.string().optional().nullable(),
  iccid: z.string().optional().nullable(),
  simType: z.string().optional().nullable(),
  lastRechargeDate: z.preprocess((val) => (val ? new Date(val as string) : null), z.date().optional().nullable()),
  validityExpiryDate: z.preprocess((val) => (val ? new Date(val as string) : null), z.date().optional().nullable()),
});

/**
 * PUT /api/v1/devices/:id/sim
 * Dedicated endpoint for SIM & Connectivity details.
 * SIM Card photograph is strictly mandatory.
 */
router.put('/:id/sim', authenticate, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid device ID' });

    const existing = await prisma.deviceRegistry.findUnique({
      where: { id },
      include: { master: true },
    });
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    const data = simUpdateSchema.parse(req.body);

    let finalPhotoUrl = data.simPhotoUrl || null;

    if (data.imageBase64 && data.imageBase64.trim() !== '') {
      finalPhotoUrl = await uploadSimImage(data.imageBase64);
    }

    if (!finalPhotoUrl) {
      finalPhotoUrl = (existing as any).simPhotoUrl || null;
    }

    if (!finalPhotoUrl && existing.masterId) {
      const evidence = await prisma.installationEvidence.findFirst({
        where: { masterId: existing.masterId, category: 'SIM_CARD' },
        orderBy: { createdAt: 'desc' },
      });
      if (evidence?.imageUrl) {
        finalPhotoUrl = evidence.imageUrl;
      }
    }

    if (!finalPhotoUrl || finalPhotoUrl.trim() === '') {
      return res.status(400).json({
        error: 'SIM Card photograph is mandatory. Please capture or upload a clear photo of the SIM card.',
      });
    }

    const updated = await prisma.deviceRegistry.update({
      where: { id },
      data: {
        simPhotoUrl: finalPhotoUrl,
        simProvider: data.simProvider !== undefined ? data.simProvider : (existing as any).simProvider,
        simNumber: data.simNumber !== undefined ? data.simNumber : (existing as any).simNumber,
        iccid: data.iccid !== undefined ? data.iccid : (existing as any).iccid,
        simType: data.simType !== undefined ? data.simType : ((existing as any).simType || 'M2M'),
        lastRechargeDate: data.lastRechargeDate !== undefined ? data.lastRechargeDate : (existing as any).lastRechargeDate,
        validityExpiryDate: data.validityExpiryDate !== undefined ? data.validityExpiryDate : (existing as any).validityExpiryDate,
      } as any,
      include: {
        gate: true,
        master: true,
        childDevice: true,
      },
    });

    // Also sync to InstallationEvidence if device is linked to a MasterUnit
    if (existing.masterId && (data.imageBase64 || data.simPhotoUrl)) {
      try {
        const existingEv = await prisma.installationEvidence.findFirst({
          where: { masterId: existing.masterId, category: 'SIM_CARD' },
        });
        if (existingEv) {
          await prisma.installationEvidence.update({
            where: { id: existingEv.id },
            data: { imageUrl: finalPhotoUrl },
          });
        } else {
          await prisma.installationEvidence.create({
            data: {
              category: 'SIM_CARD',
              imageUrl: finalPhotoUrl,
              userId: req.user?.id || 1,
              masterId: existing.masterId,
            },
          });
        }
      } catch (evErr) {
        console.warn('Syncing SIM photo to installation evidence non-critical warning:', evErr);
      }
    }

    res.json({
      message: 'SIM details updated successfully',
      device: updated,
    });
  } catch (error) {
    next(error);
  }
});

const rechargeSchema = z.object({
  lastRechargeDate: z.preprocess((val) => (val ? new Date(val as string) : new Date()), z.date()),
  validityExpiryDate: z.preprocess((val) => (val ? new Date(val as string) : null), z.date({
    required_error: 'Validity expiry date is required',
    invalid_type_error: 'Valid expiry date is required',
  })),
  amount: z.number().optional().nullable(),
  notes: z.string().optional().nullable(),
});

/**
 * POST /api/v1/devices/:id/recharge
 * Quick action to record a SIM plan recharge and extend validity.
 */
router.post('/:id/recharge', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid device ID' });

    const existing = await prisma.deviceRegistry.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Device not found' });

    const data = rechargeSchema.parse(req.body);

    const updated = await prisma.deviceRegistry.update({
      where: { id },
      data: {
        lastRechargeDate: data.lastRechargeDate,
        validityExpiryDate: data.validityExpiryDate,
      } as any,
      include: {
        gate: true,
        master: true,
        childDevice: true,
      },
    });

    res.json({
      message: 'SIM recharge logged successfully',
      device: updated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/devices/:id
 * Remove or decommission device from registry
 */
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid device ID' });

    const device = await prisma.deviceRegistry.findUnique({
      where: { id },
      select: { id: true, thingName: true, serialNumber: true, gateId: true }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found in registry' });
    }

    // Clean up associated telemetries
    await prisma.deviceTelemetry.deleteMany({
      where: {
        OR: [
          { deviceRegistryId: id },
          { thingName: device.thingName },
          ...(device.serialNumber ? [{ thingName: device.serialNumber }] : [])
        ]
      }
    }).catch(console.warn);

    // Clean up scope group device mappings
    // Delete device from registry
    await prisma.deviceRegistry.delete({ where: { id } });

    // Invalidate Cluster cache if deleted device was assigned to a gate
    if (device.gateId) {
      await bumpDirectoryRevision([], true);
    }

    res.status(200).json({
      success: true,
      message: `Device "${device.thingName}" successfully deleted from registry.`,
      deletedThingName: device.thingName
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/devices/manifest
 * Direct Firmware Manifest Ingestion Endpoint
 */
function parseFlexibleDate(rawDate?: any): Date | null {
  if (!rawDate) return null;
  const str = String(rawDate).trim();
  const dmyMatch = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const d = new Date(Date.UTC(year, month, day));
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * POST /api/v1/devices/manifest
 * Direct Firmware Manifest Ingestion Endpoint
 * Called by edge firmware (via HTTPS from LTE modem), AWS IoT Rules (from topic lc/devices/+/manifest),
 * or provisioning tools to register/update exact hardware and sensor configurations.
 */
router.post('/manifest', async (req, res, next) => {
  try {
    const raw = req.body;

    // Check if payload has nested { thing: { Master: { ... } } } or { Master: { ... } }
    const thingObj = raw.thing || raw.Thing || {};
    const masterObj = thingObj.Master || thingObj.master || raw.Master || raw.master || {};
    const slaveObj = masterObj.Slave || masterObj.slave || raw.Slave || raw.slave || raw.slaves || raw.Slaves || null;

    const hw = typeof raw.hardware === 'object' && raw.hardware !== null ? raw.hardware : {};
    const fw = typeof raw.firmware === 'object' && raw.firmware !== null ? raw.firmware : {};
    const mfg = typeof raw.manufacturing === 'object' && raw.manufacturing !== null ? raw.manufacturing : {};
    const attrs = typeof raw.attributes === 'object' && raw.attributes !== null ? raw.attributes : {};

    // Flexible identifier detection: S.No., serialNumber, thingName, etc.
    const thingName = raw.thingName || raw.thing_name || raw.topicThingName || 
      masterObj['S.No.'] || masterObj['S.No'] || masterObj.sNo || masterObj.serialNumber ||
      raw.deviceId || raw.device_id || raw.serialNumber || raw.serial_number || attrs.thingName || attrs.serialNumber;
    
    if (!thingName) {
      return res.status(400).json({ error: 'A device identifier (thingName, serialNumber, or Master.S.No.) is required in the payload' });
    }

    if (!thingName.toUpperCase().startsWith('LC-')) {
      return res.status(400).json({
        error: `Manifest rejected: thingName "${thingName}" must follow LC Gate standards and start with "LC-" (e.g. LC-M-001)`
      });
    }

    const serialNumber = masterObj['S.No.'] || masterObj['S.No'] || masterObj.serialNumber || raw.serialNumber || raw.serial_number || hw.serialNumber || attrs.serialNumber || thingName;
    const deviceType = 'MASTER'; // Physical cloud-connected IoT Things are Master units; slaves are wired sub-components!
    const deviceName = masterObj['Device_Name'] || masterObj.deviceName || raw.deviceName || hw.deviceName || 'LC Gate';
    const description = masterObj['Desc'] || masterObj.description || raw.description || hw.description || 'Installed on IR Level Crossings';
    const firmwareVersion = masterObj.version ? String(masterObj.version) : (fw.version || raw.firmwareVersion || raw.firmware_version || (typeof raw.firmware === 'string' ? raw.firmware : null) || attrs.firmwareVersion || null);
    const hardwareVersion = hw.version || raw.hardwareVersion || raw.hardware_version || (typeof raw.hardware === 'string' ? raw.hardware : null) || attrs.hardwareVersion || null;
    const macAddress = hw.macAddress || raw.macAddress || raw.mac || attrs.macAddress || null;
    const imei = hw.imei || raw.imei || attrs.imei || null;
    const manufacturer = mfg.manufacturer || raw.manufacturer || attrs.manufacturer || null;
    const modelNumber = mfg.modelNumber || raw.modelNumber || raw.model || attrs.modelNumber || null;
    const batchNumber = mfg.batchNumber || raw.batchNumber || raw.batch || attrs.batchNumber || null;

    const rawDate = masterObj['Mfg'] || masterObj.mfg || mfg.dateOfMfg || raw.dateOfMfg || raw.mfgDate || attrs.dateOfMfg;
    const dateOfMfg = parseFlexibleDate(rawDate);

    // Extract wired slaves & their sensors
    let parsedSlaves: any[] = [];
    if (Array.isArray(slaveObj)) {
      parsedSlaves = slaveObj;
    } else if (typeof slaveObj === 'object' && slaveObj !== null) {
      const sensorsData = slaveObj.Sensors?.SensorName || slaveObj.sensors?.sensorName || slaveObj.Sensors || slaveObj.sensors || [];
      const sensorList = Array.isArray(sensorsData) ? sensorsData : [sensorsData];
      const normalizedSensors = sensorList.map((s: any) => typeof s === 'string' ? { name: s } : s);
      parsedSlaves = [
        {
          slaveId: `${serialNumber}-A`,
          name: 'Barrier A',
          type: 'DEVICE_1',
          connection: 'WIRED',
          sensors: normalizedSensors.length > 0 ? normalizedSensors : [
            { name: 'HallEffect Sensor', description: 'Boom barrier position detection' },
            { name: 'LimitSwitch', description: 'End-stop & locking mechanism' }
          ]
        },
        {
          slaveId: `${serialNumber}-B`,
          name: 'Barrier B',
          type: 'DEVICE_2',
          connection: 'WIRED',
          sensors: normalizedSensors.length > 0 ? normalizedSensors : [
            { name: 'HallEffect Sensor', description: 'Boom barrier position detection' },
            { name: 'LimitSwitch', description: 'End-stop & locking mechanism' }
          ]
        }
      ];
    } else {
      // Default wired slaves A & B for an LC Gate controller
      parsedSlaves = [
        {
          slaveId: `${serialNumber}-A`,
          name: 'Barrier A',
          type: 'DEVICE_1',
          connection: 'WIRED',
          sensors: [
            { name: 'HallEffect Sensor', description: 'Boom barrier position detection' },
            { name: 'LimitSwitch', description: 'End-stop & locking mechanism' }
          ]
        },
        {
          slaveId: `${serialNumber}-B`,
          name: 'Barrier B',
          type: 'DEVICE_2',
          connection: 'WIRED',
          sensors: [
            { name: 'HallEffect Sensor', description: 'Boom barrier position detection' },
            { name: 'LimitSwitch', description: 'End-stop & locking mechanism' }
          ]
        }
      ];
    }

    // Dynamic Master sensors: Solar, Battery, Doppler Radar, etc.
    const sensors = raw.sensors !== undefined ? raw.sensors : (attrs.sensors !== undefined ? attrs.sensors : (raw.telemetry?.sensors || null));

    // Dynamic components: Store wired slaves under components so UI shows them clearly
    const components = raw.components !== undefined ? raw.components : parsedSlaves;

    // Preserve all custom keys
    const dynamicAttributes = {
      ...attrs,
      ...raw,
      deviceName,
      description,
      slaves: parsedSlaves,
      hardware: { ...hw, deviceName, description },
      firmware: { ...fw, version: firmwareVersion },
    };
    delete dynamicAttributes.attributes;

    const resolved = await resolveGateAssociations(serialNumber, raw.gateId);

    // If masterId is resolved, automatically synchronize ChildDevice table with wired slaves
    if (resolved.masterId) {
      for (const slave of parsedSlaves) {
        const existingChild = await prisma.childDevice.findUnique({ where: { serialNumber: slave.slaveId } });
        if (!existingChild) {
          await prisma.childDevice.create({
            data: {
              serialNumber: slave.slaveId,
              type: slave.type,
              deviceSequence: slave.type === 'DEVICE_2' ? 2 : 1,
              masterId: resolved.masterId,
            }
          }).catch(console.warn);
        }
      }
    }

    const device = await prisma.deviceRegistry.upsert({
      where: { thingName },
      create: {
        thingName,
        thingArn: raw.thingArn || `arn:aws:iot:ap-south-1:lcgate:thing/${thingName}`,
        thingTypeName: raw.thingTypeName || 'MasterUnit',
        deviceType,
        serialNumber,
        status: raw.status || 'ACTIVE',
        gateId: resolved.gateId,
        masterId: resolved.masterId,
        childDeviceId: null,
        macAddress,
        imei,
        firmwareVersion,
        hardwareVersion,
        dateOfMfg,
        manufacturer,
        modelNumber,
        batchNumber,
        sensors,
        components,
        attributes: dynamicAttributes,
        metadata: {
          registeredVia: 'FIRMWARE_MANIFEST_API',
          ingestedAt: new Date().toISOString(),
          rawPayload: raw,
        },
        lastSeenAt: new Date(),
      },
      update: {
        deviceType,
        serialNumber,
        status: raw.status || 'ACTIVE',
        gateId: resolved.gateId,
        masterId: resolved.masterId,
        childDeviceId: null,
        macAddress: macAddress || undefined,
        imei: imei || undefined,
        firmwareVersion: firmwareVersion || undefined,
        hardwareVersion: hardwareVersion || undefined,
        dateOfMfg: dateOfMfg || undefined,
        manufacturer: manufacturer || undefined,
        modelNumber: modelNumber || undefined,
        batchNumber: batchNumber || undefined,
        sensors: sensors !== undefined && sensors !== null ? sensors : undefined,
        components: components !== undefined && components !== null ? components : undefined,
        attributes: dynamicAttributes,
        metadata: {
          registeredVia: 'FIRMWARE_MANIFEST_API',
          updatedAt: new Date().toISOString(),
          rawPayload: raw,
        },
        lastSeenAt: new Date(),
      },
      include: {
        gate: {
          select: { id: true, lcNumber: true, locationName: true, zone: true }
        }
      }
    });

    // Record into common telemetry table for device-wise historic payload inspection
    await prisma.deviceTelemetry.create({
      data: {
        thingName,
        topic: raw.topic || `lc-gate/${thingName}/manifest`,
        payload: raw,
        status: 'ONLINE',
        deviceRegistryId: device.id,
        receivedAt: new Date(),
      }
    }).catch(console.warn);

    res.json({
      message: 'Dynamic firmware manifest received and device hardware profile registered successfully',
      device,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/devices/simulate-iot-event
 * Simulates the AWS IoT Lifecycle Rule payload as if received from AWS IoT Core:
 * topic: $aws/events/thing/<thingName>/created
 */
router.post('/simulate-iot-event', authenticate, async (req, res, next) => {
  try {
    const payload = req.body;
    const thingName = payload.thingName || payload.thing_name;

    if (!thingName) {
      return res.status(400).json({ error: 'thingName is required in event payload' });
    }

    if (!thingName.toUpperCase().startsWith('LC-')) {
      return res.status(400).json({ error: `Event rejected: thingName "${thingName}" must follow LC Gate standards and start with "LC-" (e.g. LC-M-001)` });
    }

    const attrs = payload.attributes || {};
    const serialNumber = attrs.serialNumber || payload.serialNumber || thingName;
    const resolved = await resolveGateAssociations(serialNumber, null);

    const device = await prisma.deviceRegistry.upsert({
      where: { thingName },
      create: {
        thingName,
        thingArn: payload.thingArn || `arn:aws:iot:ap-south-1:lcgate:thing/${thingName}`,
        thingTypeName: payload.thingTypeName || 'MasterUnit',
        deviceType: attrs.deviceType || payload.deviceType || 'MASTER',
        serialNumber,
        status: 'ACTIVE',
        gateId: resolved.gateId,
        masterId: resolved.masterId,
        childDeviceId: resolved.childDeviceId,
        manufacturer: attrs.manufacturer || payload.manufacturer || null,
        modelNumber: attrs.modelNumber || payload.modelNumber || null,
        firmwareVersion: attrs.firmwareVersion || payload.firmwareVersion || null,
        hardwareVersion: attrs.hardwareVersion || payload.hardwareVersion || null,
        dateOfMfg: attrs.dateOfMfg ? parseFlexibleDate(attrs.dateOfMfg) : (payload.dateOfMfg ? parseFlexibleDate(payload.dateOfMfg) : null),
        sensors: payload.sensors || (attrs.sensors ? (typeof attrs.sensors === 'string' ? JSON.parse(attrs.sensors) : attrs.sensors) : []),
        components: payload.components || (attrs.components ? (typeof attrs.components === 'string' ? JSON.parse(attrs.components) : attrs.components) : []),
        attributes: attrs,
        metadata: {
          simulatedBy: 'LC-Platform API Simulator',
          simulatedAt: new Date().toISOString(),
          originalEvent: payload,
        },
        lastSeenAt: new Date(),
      },
      update: {
        lastSeenAt: new Date(),
        status: 'ACTIVE',
        sensors: payload.sensors && payload.sensors.length > 0 ? payload.sensors : undefined,
        components: payload.components && payload.components.length > 0 ? payload.components : undefined,
      },
    });

    // Record into common telemetry table
    await prisma.deviceTelemetry.create({
      data: {
        thingName,
        topic: payload.topic || `$aws/events/thing/${thingName}/created`,
        payload,
        status: 'ONLINE',
        deviceRegistryId: device.id,
        receivedAt: new Date(),
      }
    }).catch(console.warn);

    res.json({
      message: 'Simulated AWS IoT Thing registration processed and stored in RDS successfully',
      device,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
