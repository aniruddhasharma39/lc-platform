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
import { deleteEvidenceFile } from './evidence';
import {
  cleanupDetachedThingEventsInTx,
  computeThingConnectivity,
  isGenuineTelemetryPacket,
  isManifestPacket,
  normalizeBarrierStateColumn,
  parseBarrierStateFromPayload,
} from '../lib/thingState';
// @ts-ignore
import { Jimp, loadFont } from 'jimp';
// @ts-ignore
import { SANS_16_WHITE, SANS_16_BLACK } from 'jimp/fonts';

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

  let stampedBuffer: Buffer = buffer;
  try {
    const image = await Jimp.read(buffer);
    if (image.bitmap && (image.bitmap.width > 2048 || image.bitmap.height > 2048)) {
      if (image.bitmap.width >= image.bitmap.height) {
        image.resize({ w: 2048 });
      } else {
        image.resize({ h: 2048 });
      }
    }
    const dateStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const text = `SIM Proof | ${dateStr}`;
    const fontWhite = await loadFont(SANS_16_WHITE);
    const fontBlack = await loadFont(SANS_16_BLACK);
    image.print({ font: fontBlack, x: 13, y: 13, text });
    image.print({ font: fontWhite, x: 12, y: 12, text });
    stampedBuffer = await image.getBuffer('image/jpeg');
  } catch (jimpErr) {
    console.warn('Jimp watermarking failed for SIM photo, using original buffer:', jimpErr);
    stampedBuffer = buffer;
  }

  const filename = `${crypto.randomUUID()}.jpg`;
  const filepath = path.join(uploadsDir, filename);
  try {
    fs.writeFileSync(filepath, stampedBuffer);
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
      stream.end(stampedBuffer);
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
  manufacturer: z.string().optional().nullable(),
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

    const [total, active, provisioned, masters, onlineCount] = await Promise.all([
      prisma.deviceRegistry.count({ where: baseWhere }),
      prisma.deviceRegistry.count({ where: { ...baseWhere, status: 'ACTIVE' } }),
      prisma.deviceRegistry.count({ where: { ...baseWhere, status: 'PROVISIONED' } }),
      prisma.deviceRegistry.count({
        where: {
          thingName: { startsWith: 'LC-', mode: 'insensitive' },
          deviceType: { in: ['MASTER', 'master', 'LC_GATE_MASTER', 'GATE_MASTER', 'LC-GATE-MASTER', 'MASTER_UNIT', 'LC_MASTER'] },
        },
      }),
      prisma.deviceRegistry.count({ where: { ...baseWhere, connectivityStatus: 'ONLINE' } }),
    ]);

    res.json({
      total,
      active,
      provisioned,
      masters,
      onlineCount,
      offlineCount: Math.max(0, total - onlineCount),
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

    const enrichedDevices = await Promise.all(devices.map(async (device) => {
      // Query strictly genuine inbound /telemetry packets matched only by thingName or deviceRegistryId
      const latestTele = await prisma.deviceTelemetry.findFirst({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id },
          ],
          topic: { contains: '/telemetry' },
          NOT: [
            { topic: { contains: '/health' } },
            { topic: { contains: '/request' } },
            { topic: { contains: '/manifest' } },
          ],
          status: { not: 'REQUESTED' },
        },
        orderBy: { receivedAt: 'desc' },
      }).catch(() => null);

      const latestHealth = await prisma.deviceHealthCheck.findFirst({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }).catch(() => null);

      // Compute latest real inbound packet timestamp
      const timestamps = [
        latestTele?.receivedAt ? new Date(latestTele.receivedAt).getTime() : 0,
        latestHealth?.createdAt ? new Date(latestHealth.createdAt).getTime() : 0,
        device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0,
      ];
      const maxTimestamp = Math.max(...timestamps);
      const lastTimestamp = maxTimestamp > 0 ? new Date(maxTimestamp) : null;
      const conn = computeThingConnectivity({
        status: device.status,
        connectivityStatus: (device as any).connectivityStatus,
        lastSeenAt: lastTimestamp,
      }, now);

      let simPhotoUrl = (device as any).simPhotoUrl;
      if (device.masterId) {
        const simEvidence = await prisma.installationEvidence.findFirst({
          where: { masterId: device.masterId, category: 'SIM_CARD' },
          orderBy: { updatedAt: 'desc' },
          select: { imageUrl: true },
        }).catch(() => null);
        if (simEvidence?.imageUrl) {
          simPhotoUrl = simEvidence.imageUrl;
          if ((device as any).simPhotoUrl !== simEvidence.imageUrl) {
            prisma.deviceRegistry.update({
              where: { id: device.id },
              data: { simPhotoUrl: simEvidence.imageUrl },
            }).catch(() => {});
          }
        }
      }

      const barrierState = normalizeBarrierStateColumn((device as any).barrierState);

      return {
        ...device,
        simPhotoUrl,
        barrierState,
        connectivityStatus: conn.connectivityStatus,
        computedStatus: conn.connectivityStatus,
        isOnline: conn.isOnline,
        latestPayloadSent: conn.lastSeenAt,
        latestTopic: latestTele?.topic || null,
        latestPayload: latestTele?.payload || null,
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
          ],
          NOT: [{ topic: { contains: '/request' } }],
          status: { not: 'REQUESTED' },
        },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }).catch(() => []),
      prisma.deviceHealthCheck.findMany({
        where: {
          OR: [
            { thingName: device.thingName },
            { deviceRegistryId: device.id },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => [])
    ]);

    const telemetryRecords = telemetries.filter(isGenuineTelemetryPacket);
    const manifestRecords = telemetries.filter(isManifestPacket);

    const healthRecords = healthChecks.length > 0 ? healthChecks.map((h: any) => ({
      id: h.id,
      thingName: h.thingName,
      topic: `lc-gate/${h.thingName}/health`,
      payload: h.rawPayload,
      status: h.healthstatus || null,
      receivedAt: h.createdAt,
      deviceRegistryId: h.deviceRegistryId,
      gateStatus: h.gateStatus,
      isDedicatedHealthCheck: true,
    })) : telemetries.filter(t =>
      ((t.topic && t.topic.includes('/health') && !t.topic.includes('/request')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK_RESPONSE' || (t.payload as any).healthstatus !== undefined)))
    );

    const nowMs = Date.now();
    const latestTimestamp = telemetryRecords[0]?.receivedAt || healthRecords[0]?.receivedAt || device.lastSeenAt || null;
    const conn = computeThingConnectivity({
      status: device.status,
      connectivityStatus: (device as any).connectivityStatus,
      lastSeenAt: latestTimestamp,
    }, nowMs);
    const computedStatus = conn.connectivityStatus;
    const isOnline = conn.isOnline;

    // Single source of truth: DB barrierState populated strictly from genuine /telemetry packets
    const barrierState = normalizeBarrierStateColumn((device as any).barrierState);
    const currentStatus = barrierState || 'NO_TELEMETRY';

    const seenUids = new Set<string>();
    const deduplicatedPayloads: any[] = [];
    if (healthChecks.length > 0) {
      for (const h of healthRecords) {
        const uid = `hc-${h.id}`;
        if (!seenUids.has(uid)) {
          seenUids.add(uid);
          deduplicatedPayloads.push(h);
        }
      }
    }
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
      barrierState,
      currentStatus,
      connectivityStatus: computedStatus,
      computedStatus,
      isOnline,
      lastSeenAt: latestTimestamp,
      lastTelemetryAt: (device as any).lastTelemetryAt || null,
      counts: {
        all: deduplicatedPayloads.length,
        telemetry: telemetryRecords.length,
        manifest: manifestRecords.length,
        healthCheck: healthRecords.length,
      },
      latestTelemetry: telemetryRecords[0] || null,
      latestManifest: manifestRecords[0] || null,
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

    await prisma.$transaction(async (tx) => {
      if (device.gateId) {
        await cleanupDetachedThingEventsInTx(tx, {
          gateId: device.gateId,
          masterId: device.masterId,
          thingName,
        });
      }

      await tx.deviceTelemetry.deleteMany({
        where: {
          OR: [
            { thingName },
            { deviceRegistryId: device.id },
          ],
        },
      });
      await tx.deviceHealthCheck.deleteMany({
        where: {
          OR: [
            { thingName },
            { deviceRegistryId: device.id },
          ],
        },
      });

      await tx.deviceRegistry.delete({
        where: { id: device.id },
      });

      if (device.gateId) {
        await bumpDirectoryRevision([device.gateId], true, tx);
      }
    }, { maxWait: 5000, timeout: 20000 });

    if (device.gateId) {
      clusterCacheManager.clear();
      broadcastGateTelemetry(device.gateId).catch(console.warn);
    }

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

    // Publish directly to AWS IoT Core MQTT broker without polluting DeviceTelemetry with fake status rows
    const mqttResult = await publishMqttMessage(topic, commandPayload);

    res.json({
      message: mqttResult.success
        ? `Health check command published over AWS IoT MQTT to ${topic}`
        : `Health check command failed to reach MQTT broker for ${device.thingName} (${mqttResult.error || 'broker offline'})`,
      topic,
      requestId,
      mqttDelivered: mqttResult.success,
      mqttError: mqttResult.error || null,
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

    const fwVersion = payload.FirmwareVersion || payload.firmwareVersion || undefined;
    const isPingRequestEcho = String(topic).includes('/health/request') || payload.action === 'HEALTH_CHECK';
    if (isPingRequestEcho) {
      return res.status(200).json({ message: 'Health request command ignored by inbound telemetry ingestion' });
    }

    const isHealthTopic = String(topic).includes('/health') || payload.action === 'HEALTH_CHECK_RESPONSE' || payload.healthstatus !== undefined;
    const isHealthResponse = isHealthTopic && (payload.healthstatus !== undefined || payload.action === 'HEALTH_CHECK_RESPONSE' || payload.BoomAngle !== undefined || payload.LimitSwitchClosed !== undefined);
    const isManifest = isManifestPacket({ topic, payload });
    const isTelemetry = !isHealthResponse && !isManifest && isGenuineTelemetryPacket({ topic, payload });
    const incomingAt = raw.timestamp ? new Date(raw.timestamp) : new Date();

    const heartbeatResult = await prisma.$transaction(async (tx) => {
      // 1. Row-level lock strictly on exact thingName (zero serialNumber cross-matching fallback)
      const lockedRows: any[] = await tx.$queryRaw`
        SELECT id, "thingName", "serialNumber", "gateId", "masterId", "lastSeenAt", "firmwareVersion", "status", "connectivityStatus", "barrierState"
        FROM "DeviceRegistry"
        WHERE "thingName" = ${thingName}
        LIMIT 1
        FOR UPDATE
      `;
      let dev = lockedRows.length > 0 ? lockedRows[0] : null;
      const previousBarrierState = normalizeBarrierStateColumn(dev?.barrierState);

      // 2. Parse authoritative barrier state strictly from physical payload fields (OPEN | CLOSED | null)
      const currentState = (isTelemetry || isHealthResponse)
        ? parseBarrierStateFromPayload(payload)
        : null;

      // 3. Detect if device was previously OFFLINE (>65m or never seen) before this packet
      let wasOffline = false;

      if (!dev) {
        if (!thingName.toUpperCase().startsWith('LC-')) {
          return { ignored: true, device: null, wasOffline: false, telemetry: null, healthCheck: null, isHealthResponse: false, currentState: null, previousState: null };
        }

        // Newly discovered AWS IoT Things always start UNASSIGNED and lifecycle ACTIVE (never ONLINE/OPEN guesses)
        const insertedRows: any[] = await tx.$queryRaw`
          INSERT INTO "DeviceRegistry" (
            "thingName", "serialNumber", "status", "connectivityStatus", "barrierState", "lastTelemetryAt",
            "gateId", "masterId", "childDeviceId", "deviceType", "firmwareVersion", "lastSeenAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${thingName}, ${thingName}, 'ACTIVE', 'ONLINE', ${currentState}, ${currentState ? incomingAt : null},
            NULL, NULL, NULL, ${payload.DeviceType || 'MASTER'}, ${fwVersion || null}, ${incomingAt}, NOW(), NOW()
          )
          ON CONFLICT ("thingName") DO UPDATE
          SET "lastSeenAt" = ${incomingAt},
              "connectivityStatus" = 'ONLINE',
              "barrierState" = COALESCE(${currentState}, "DeviceRegistry"."barrierState"),
              "lastTelemetryAt" = CASE WHEN ${currentState !== null} THEN ${incomingAt} ELSE "DeviceRegistry"."lastTelemetryAt" END,
              "firmwareVersion" = COALESCE(${fwVersion || null}, "DeviceRegistry"."firmwareVersion"),
              "updatedAt" = NOW()
          RETURNING id, "thingName", "serialNumber", "gateId", "masterId", "lastSeenAt", "firmwareVersion", "status", "connectivityStatus", "barrierState", (xmax = 0) AS is_inserted
        `;
        dev = insertedRows[0];
        wasOffline = Boolean(dev.is_inserted);
      } else {
        wasOffline =
          dev.connectivityStatus !== 'ONLINE' ||
          !dev.lastSeenAt ||
          (Date.now() - new Date(dev.lastSeenAt).getTime() > 65 * 60 * 1000);
        // Preserve lifecycle `status`, gate/master linkage, and update connectivityStatus + authoritative barrierState
        dev = await tx.deviceRegistry.update({
          where: { id: dev.id },
          data: {
            lastSeenAt: incomingAt,
            connectivityStatus: 'ONLINE',
            firmwareVersion: fwVersion || dev.firmwareVersion,
            ...(currentState ? {
              barrierState: currentState,
              lastTelemetryAt: incomingAt,
            } : {}),
          }
        });
      }

      if (wasOffline) {
        await bumpDirectoryRevision([], true, tx);
      }

      // 4. Determine genuine previous state strictly from previousBarrierState (or previous /telemetry row if never cached yet)
      let previousState = previousBarrierState;
      if (!previousState) {
        const previousTele = await tx.deviceTelemetry.findFirst({
          where: {
            OR: [
              { thingName: dev.thingName },
              { deviceRegistryId: dev.id },
            ],
            topic: { contains: '/telemetry' },
            NOT: [
              { topic: { contains: '/health' } },
              { topic: { contains: '/request' } },
            ],
            status: { not: 'REQUESTED' },
          },
          orderBy: { receivedAt: 'desc' },
        });
        if (previousTele?.payload) {
          previousState = parseBarrierStateFromPayload(previousTele.payload);
        }
      }

      // 5. Save authentic telemetry or health diagnostic report (zero fabricated defaults)
      let createdHealth: any = null;
      let createdTele: any = null;

      if (isHealthResponse) {
        createdHealth = await tx.deviceHealthCheck.create({
          data: {
            thingName: dev.thingName,
            requestId: payload.requestId || null,
            healthstatus: payload.healthstatus || null,
            gateStatus: parseBarrierStateFromPayload(payload),
            boomAngle: payload.BoomAngle !== undefined && payload.BoomAngle !== null ? parseFloat(payload.BoomAngle) : null,
            mcuTempC: payload.McuTempC !== undefined && payload.McuTempC !== null ? parseFloat(payload.McuTempC) : null,
            signalStrength: payload.SignalStrength !== undefined && payload.SignalStrength !== null ? parseInt(payload.SignalStrength) : null,
            networkType: payload.NetworkType || payload.networkType || null,
            limitSwitchClosed: payload.LimitSwitchClosed !== undefined && payload.LimitSwitchClosed !== null ? Boolean(payload.LimitSwitchClosed) : null,
            hallClosed: payload.HallClosed !== undefined && payload.HallClosed !== null ? Boolean(payload.HallClosed) : null,
            batteryVoltage: payload.BatteryVoltage !== undefined && payload.BatteryVoltage !== null ? parseFloat(payload.BatteryVoltage) : null,
            batteryPercentage: payload.BatteryPercentage !== undefined && payload.BatteryPercentage !== null ? parseInt(payload.BatteryPercentage) : null,
            solarVoltage: payload.SolarVoltage !== undefined && payload.SolarVoltage !== null ? parseFloat(payload.SolarVoltage) : null,
            solarCharging: payload.SolarCharging !== undefined && payload.SolarCharging !== null ? Boolean(payload.SolarCharging) : null,
            uptimeSeconds: payload.UptimeSeconds !== undefined && payload.UptimeSeconds !== null ? parseInt(payload.UptimeSeconds) : null,
            firmwareVersion: payload.FirmwareVersion || fwVersion || null,
            rawPayload: payload,
            deviceRegistryId: dev.id,
            createdAt: incomingAt,
          }
        });
      } else {
        createdTele = await tx.deviceTelemetry.create({
          data: {
            thingName: dev.thingName,
            topic,
            payload,
            status: currentState || (isManifest ? 'MANIFEST' : null),
            deviceRegistryId: dev.id,
            receivedAt: incomingAt,
          }
        });
        if (currentState) {
          dev = await tx.deviceRegistry.update({
            where: { id: dev.id },
            data: { lastTelemetryId: createdTele.id },
          });
        }
      }

      return {
        ignored: false,
        device: dev,
        wasOffline,
        telemetry: createdTele,
        healthCheck: createdHealth,
        isHealthResponse,
        currentState,
        previousState,
      };
    }, { maxWait: 5000, timeout: 20000 });

    if (heartbeatResult.ignored) {
      return res.status(200).json({
        message: `Foreign telemetry ignored: thingName "${thingName}" does not belong to LC Platform (must start with "LC-")`
      });
    }

    const device = heartbeatResult.device!;
    const { telemetry, healthCheck, currentState, previousState } = heartbeatResult;

    if (heartbeatResult.wasOffline) {
      clusterCacheManager.invalidateAll();
    }

    if (heartbeatResult.isHealthResponse) {
      if (device.gateId) {
        broadcastGateTelemetry(device.gateId).catch(console.warn);
      }
      return res.status(201).json({
        message: 'Health diagnostic report recorded in DeviceHealthCheck table',
        healthCheck,
        device: { id: device.id, thingName: device.thingName, status: device.status, connectivityStatus: device.connectivityStatus, barrierState: device.barrierState }
      });
    }

    // Trigger operational event recording and SMS alert ONLY on real barrier state telemetry
    if (currentState && telemetry) {
      if (!previousState || currentState !== previousState) {
        console.log(`⚡ [STATE DETECTED] Gate "${device.thingName}": ${previousState || 'INITIAL'} ➔ ${currentState}`);

        if (previousState && currentState === 'OPEN' && currentState !== previousState) {
          checkAndDispatchGateStateAlert({
            deviceId: device.id,
            gateId: device.gateId,
            masterId: device.masterId,
            thingName: device.thingName,
            serialNumber: device.serialNumber,
            newState: currentState,
            timestamp: telemetry.receivedAt,
          }).catch(err => console.error('Error dispatching gate state alert:', err));
        }

        recordGateTelemetryTransition({
          gateId: device.gateId,
          masterId: device.masterId,
          thingName: device.thingName,
          newState: currentState,
          timestamp: telemetry.receivedAt,
        }).catch(err => console.error('Error recording telemetry event for reports:', err));
      }
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
        alertDispatched: currentState === 'OPEN'
      } : null,
      device: {
        id: device.id,
        thingName: device.thingName,
        status: device.status,
        connectivityStatus: device.connectivityStatus,
        barrierState: device.barrierState,
        lastSeenAt: device.lastSeenAt,
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
    if (device.masterId) {
      const simEvidence = await prisma.installationEvidence.findFirst({
        where: { masterId: device.masterId, category: 'SIM_CARD' },
        orderBy: { updatedAt: 'desc' },
        select: { imageUrl: true },
      }).catch(() => null);
      if (simEvidence?.imageUrl) {
        simPhotoUrl = simEvidence.imageUrl;
        if ((device as any).simPhotoUrl !== simEvidence.imageUrl) {
          prisma.deviceRegistry.update({
            where: { id: device.id },
            data: { simPhotoUrl: simEvidence.imageUrl },
          }).catch(() => {});
        }
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

    // Explicit bindings only; never auto-guess Gate/Master/Slave by serial string prefix
    const gateId = data.gateId ?? null;
    const masterId = data.masterId ?? null;
    const childDeviceId = data.childDeviceId ?? null;
    if (gateId && !masterId) {
      return res.status(400).json({ error: 'Explicit masterId is required when assigning a device to a gate.' });
    }

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
      } else if (masterId === undefined) {
        return res.status(400).json({ error: 'Explicit masterId is required when assigning a device to a gate.' });
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

    // Reconcile SIM InstallationEvidence with DeviceRegistry on assignment or update
    const finalSimPhoto = (updated as any).simPhotoUrl;
    if (updated.masterId && finalSimPhoto) {
      try {
        const existingEv = await prisma.installationEvidence.findFirst({
          where: { masterId: updated.masterId, category: 'SIM_CARD' },
        });
        if (existingEv) {
          if (existingEv.imageUrl !== finalSimPhoto) {
            await prisma.installationEvidence.update({
              where: { id: existingEv.id },
              data: { imageUrl: finalSimPhoto },
            });
          }
        } else {
          await prisma.installationEvidence.create({
            data: {
              masterId: updated.masterId,
              category: 'SIM_CARD',
              imageUrl: finalSimPhoto,
              userId: (req as any).user?.id || 1,
            },
          });
        }
      } catch (evErr) {
        console.warn('Failed to reconcile SIM InstallationEvidence on device update:', evErr);
      }
    } else if (updated.masterId && !finalSimPhoto) {
      try {
        const simEv = await prisma.installationEvidence.findFirst({
          where: { masterId: updated.masterId, category: 'SIM_CARD' },
          orderBy: { createdAt: 'desc' },
        });
        if (simEv && simEv.imageUrl) {
          await prisma.deviceRegistry.update({
            where: { id: updated.id },
            data: { simPhotoUrl: simEv.imageUrl } as any,
          });
        }
      } catch (evErr) {
        console.warn('Failed to reverse reconcile SIM photo to DeviceRegistry:', evErr);
      }
    }

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

    if (existing.simPhotoUrl && existing.simPhotoUrl !== finalPhotoUrl) {
      await deleteEvidenceFile(existing.simPhotoUrl);
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

    // Resolve linked master ID (from existing.masterId, serialNumber, thingName, or gate's primary master)
    let linkedMasterId = existing.masterId;
    if (!linkedMasterId && existing.serialNumber) {
      const masterBySerial = await prisma.masterUnit.findUnique({
        where: { serialNumber: existing.serialNumber },
      });
      if (masterBySerial) {
        linkedMasterId = masterBySerial.id;
        await prisma.deviceRegistry.update({
          where: { id },
          data: { masterId: linkedMasterId, gateId: masterBySerial.gateId },
        }).catch(() => {});
      }
    }
    if (!linkedMasterId && existing.thingName) {
      const masterByThing = await prisma.masterUnit.findUnique({
        where: { serialNumber: existing.thingName },
      });
      if (masterByThing) {
        linkedMasterId = masterByThing.id;
        await prisma.deviceRegistry.update({
          where: { id },
          data: { masterId: linkedMasterId, gateId: masterByThing.gateId },
        }).catch(() => {});
      }
    }
    if (!linkedMasterId && existing.gateId) {
      const gateMaster = await prisma.masterUnit.findFirst({
        where: { gateId: existing.gateId },
        orderBy: { masterSequence: 'asc' },
      });
      if (gateMaster) {
        linkedMasterId = gateMaster.id;
        await prisma.deviceRegistry.update({
          where: { id },
          data: { masterId: linkedMasterId },
        }).catch(() => {});
      }
    }

    // Also sync to InstallationEvidence (single source of truth, removing duplicates)
    if (linkedMasterId && finalPhotoUrl) {
      try {
        const existingEvs = await prisma.installationEvidence.findMany({
          where: { masterId: linkedMasterId, category: 'SIM_CARD' },
          orderBy: { createdAt: 'desc' },
        });
        if (existingEvs.length > 0) {
          const primaryEv = existingEvs[0];
          if (primaryEv.imageUrl !== finalPhotoUrl) {
            await deleteEvidenceFile(primaryEv.imageUrl);
          }
          await prisma.installationEvidence.update({
            where: { id: primaryEv.id },
            data: {
              imageUrl: finalPhotoUrl,
              updatedAt: new Date(),
            },
          });
          // Remove any duplicate SIM evidence records
          for (let i = 1; i < existingEvs.length; i++) {
            if (existingEvs[i].imageUrl !== finalPhotoUrl) {
              await deleteEvidenceFile(existingEvs[i].imageUrl);
            }
            await prisma.installationEvidence.delete({ where: { id: existingEvs[i].id } });
          }
        } else {
          await prisma.installationEvidence.create({
            data: {
              category: 'SIM_CARD',
              imageUrl: finalPhotoUrl,
              userId: req.user?.id || 1,
              masterId: linkedMasterId,
            },
          });
        }

        // Keep all devices under this master in sync
        await prisma.deviceRegistry.updateMany({
          where: {
            masterId: linkedMasterId,
            id: { not: id },
          },
          data: {
            simPhotoUrl: finalPhotoUrl,
          },
        }).catch(() => {});
      } catch (evErr) {
        console.warn('Syncing SIM photo to installation evidence warning:', evErr);
      }
    }

    const gateIdToBump = existing.gateId || existing.master?.gateId;
    if (gateIdToBump || linkedMasterId) {
      try {
        const now = new Date();
        if (gateIdToBump) {
          await prisma.lCGate.update({ where: { id: gateIdToBump }, data: { updatedAt: now } }).catch(() => {});
          await bumpDirectoryRevision([gateIdToBump], true);
        }
        if (linkedMasterId) {
          await prisma.masterUnit.update({ where: { id: linkedMasterId }, data: { updatedAt: now } }).catch(() => {});
        }
        clusterCacheManager.clear();
      } catch (cErr) {
        console.warn('Cache bump after SIM update non-critical error:', cErr);
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

    if (existing.gateId || (existing as any).masterId) {
      try {
        const now = new Date();
        if (existing.gateId) {
          await prisma.lCGate.update({ where: { id: existing.gateId }, data: { updatedAt: now } }).catch(() => {});
          await bumpDirectoryRevision([existing.gateId], true);
        }
        if ((existing as any).masterId) {
          await prisma.masterUnit.update({ where: { id: (existing as any).masterId }, data: { updatedAt: now } }).catch(() => {});
        }
        clusterCacheManager.clear();
      } catch (cErr) {
        console.warn('Cache bump after recharge non-critical error:', cErr);
      }
    }

    res.json({
      message: 'SIM recharge logged successfully',
      device: updated,
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
    const deviceType = 'MASTER'; // Physical cloud-connected IoT Things are Master units
    const deviceName = masterObj['Device_Name'] || masterObj.deviceName || raw.deviceName || hw.deviceName || null;
    const description = masterObj['Desc'] || masterObj.description || raw.description || hw.description || null;
    const firmwareVersion = masterObj.version ? String(masterObj.version) : (fw.version || raw.firmwareVersion || raw.firmware_version || (typeof raw.firmware === 'string' ? raw.firmware : null) || attrs.firmwareVersion || null);
    const hardwareVersion = hw.version || raw.hardwareVersion || raw.hardware_version || (typeof raw.hardware === 'string' ? raw.hardware : null) || attrs.hardwareVersion || null;
    const macAddress = hw.macAddress || raw.macAddress || raw.mac || attrs.macAddress || null;
    const imei = hw.imei || raw.imei || attrs.imei || null;
    const manufacturer = mfg.manufacturer || raw.manufacturer || attrs.manufacturer || null;
    const modelNumber = mfg.modelNumber || raw.modelNumber || raw.model || attrs.modelNumber || null;
    const batchNumber = mfg.batchNumber || raw.batchNumber || raw.batch || attrs.batchNumber || null;

    const rawDate = masterObj['Mfg'] || masterObj.mfg || mfg.dateOfMfg || raw.dateOfMfg || raw.mfgDate || attrs.dateOfMfg;
    const dateOfMfg = parseFlexibleDate(rawDate);

    // Extract slaves strictly if actually reported in manifest (zero fabricated Barrier A / B records)
    let parsedSlaves: any[] = [];
    if (Array.isArray(slaveObj)) {
      parsedSlaves = slaveObj;
    } else if (typeof slaveObj === 'object' && slaveObj !== null) {
      const sensorsData = slaveObj.Sensors?.SensorName || slaveObj.sensors?.sensorName || slaveObj.Sensors || slaveObj.sensors || [];
      const sensorList = Array.isArray(sensorsData) ? sensorsData : [sensorsData];
      const normalizedSensors = sensorList.map((s: any) => typeof s === 'string' ? { name: s } : s);
      if (normalizedSensors.length > 0) {
        parsedSlaves = [{
          slaveId: `${serialNumber}-S1`,
          name: slaveObj.name || 'Slave Sensors',
          connection: 'WIRED',
          sensors: normalizedSensors,
        }];
      }
    }

    const sensors = raw.sensors !== undefined ? raw.sensors : (attrs.sensors !== undefined ? attrs.sensors : (raw.telemetry?.sensors || null));
    const components = raw.components !== undefined ? raw.components : (parsedSlaves.length > 0 ? parsedSlaves : null);

    const dynamicAttributes: any = {
      ...attrs,
      ...raw,
      ...(deviceName ? { deviceName } : {}),
      ...(description ? { description } : {}),
      ...(parsedSlaves.length > 0 ? { slaves: parsedSlaves } : {}),
      hardware: { ...hw, ...(deviceName ? { deviceName } : {}), ...(description ? { description } : {}) },
      firmware: { ...fw, ...(firmwareVersion ? { version: firmwareVersion } : {}) },
    };
    delete dynamicAttributes.attributes;

    // Never auto-guess or overwrite gateId / masterId / childDeviceId from manifest ingestion
    const device = await prisma.deviceRegistry.upsert({
      where: { thingName },
      create: {
        thingName,
        thingArn: raw.thingArn || null,
        thingTypeName: raw.thingTypeName || 'MasterUnit',
        deviceType,
        serialNumber,
        status: raw.status || 'ACTIVE',
        connectivityStatus: 'ONLINE',
        gateId: null,
        masterId: null,
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
        ...(raw.status ? { status: raw.status } : {}),
        connectivityStatus: 'ONLINE',
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

    // Record into common telemetry table for manifest inspection
    await prisma.deviceTelemetry.create({
      data: {
        thingName,
        topic: raw.topic || `lc-gate/${thingName}/manifest`,
        payload: raw,
        status: 'MANIFEST',
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

    const device = await prisma.deviceRegistry.upsert({
      where: { thingName },
      create: {
        thingName,
        thingArn: payload.thingArn || null,
        thingTypeName: payload.thingTypeName || 'MasterUnit',
        deviceType: attrs.deviceType || payload.deviceType || 'MASTER',
        serialNumber,
        status: 'ACTIVE',
        connectivityStatus: 'ONLINE',
        gateId: null,
        masterId: null,
        childDeviceId: null,
        manufacturer: attrs.manufacturer || payload.manufacturer || null,
        modelNumber: attrs.modelNumber || payload.modelNumber || null,
        firmwareVersion: attrs.firmwareVersion || payload.firmwareVersion || null,
        hardwareVersion: attrs.hardwareVersion || payload.hardwareVersion || null,
        dateOfMfg: attrs.dateOfMfg ? parseFlexibleDate(attrs.dateOfMfg) : (payload.dateOfMfg ? parseFlexibleDate(payload.dateOfMfg) : null),
        sensors: payload.sensors || (attrs.sensors ? (typeof attrs.sensors === 'string' ? JSON.parse(attrs.sensors) : attrs.sensors) : null),
        components: payload.components || (attrs.components ? (typeof attrs.components === 'string' ? JSON.parse(attrs.components) : attrs.components) : null),
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
        connectivityStatus: 'ONLINE',
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
        status: 'MANIFEST',
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
