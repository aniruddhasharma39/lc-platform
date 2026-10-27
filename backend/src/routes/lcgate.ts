import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { RAILWAY_DATA, RAILWAY_ZONES, divisionsForZone } from '../lib/railwayData';
import { getAllDescendantScopeGroupIds } from '../lib/scopeHierarchy';
import { publishMqttMessage } from '../lib/iotClient';

const router = Router();

const createGateSchema = z.object({
  name: z.string().nullable().optional(),
  lcNumberDigits: z.string().optional(),
  lcNumber: z.string().optional(),
  deviceId: z.number().int().optional().nullable(),
  locationName: z.string().min(1),
  zone: z.string().min(1),
  division: z.string().min(1),
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
router.get('/reference-data', authenticate, async (_req, res) => {
  res.json({
    zones: RAILWAY_ZONES,
    divisionsByZone: RAILWAY_DATA,
  });
});

// Divisions for a zone (convenience; case-insensitive)
router.get('/divisions', authenticate, async (req, res) => {
  const zone = typeof req.query.zone === 'string' ? req.query.zone : '';
  res.json({ zone, divisions: divisionsForZone(zone) });
});

// Create a new LC Gate
router.post('/', authenticate, async (req, res, next) => {
  try {
    const data = createGateSchema.parse(req.body);

    let lcNumber = data.lcNumber ? data.lcNumber.trim() : '';
    if (!lcNumber && data.lcNumberDigits) {
      lcNumber = `LC-${data.lcNumberDigits.trim()}`;
    }
    if (!lcNumber) {
      return res.status(400).json({ error: 'LC Number or 4-digit number is required' });
    }
    
    // Check for existing gate
    const existing = await prisma.lCGate.findUnique({ where: { lcNumber } });
    if (existing) {
      return res.status(400).json({ error: `Gate with LC Number "${lcNumber}" already exists` });
    }

    const gateName = (data.name && data.name.trim()) 
      ? data.name.trim() 
      : (data.locationName ? `${data.locationName.trim()} (${lcNumber})` : lcNumber);

    const gate = await prisma.lCGate.create({
      data: {
        name: gateName,
        lcNumber,
        locationName: data.locationName,
        zone: data.zone,
        division: data.division,
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });

    // Auto-create initial Master Unit for this gate with the same serialNumber/ID
    let master = await prisma.masterUnit.findFirst({ where: { gateId: gate.id } });
    if (!master) {
      master = await prisma.masterUnit.create({
        data: {
          serialNumber: lcNumber,
          masterSequence: 1,
          powerSource: 'SOLAR',
          gateId: gate.id,
        },
      });
    }

    // Automatically link Master device from DeviceRegistry if deviceId or matching thingName/serial
    if (data.deviceId) {
      await prisma.deviceRegistry.updateMany({
        where: { id: data.deviceId },
        data: { gateId: gate.id, masterId: master.id }
      }).catch(console.warn);
    } else {
      await prisma.deviceRegistry.updateMany({
        where: {
          OR: [
            { thingName: lcNumber },
            { serialNumber: lcNumber }
          ],
        },
        data: { gateId: gate.id, masterId: master.id }
      }).catch(console.warn);
    }

    // Initialize the two physical wired slave units (Barrier A & Barrier B) for this master
    const defaultWiredSlaves = [
      { serial: `${lcNumber}-A`, type: 'DEVICE_1', seq: 1 },
      { serial: `${lcNumber}-B`, type: 'DEVICE_2', seq: 2 },
    ];

    for (const slave of defaultWiredSlaves) {
      let child = await prisma.childDevice.findUnique({ where: { serialNumber: slave.serial } });
      if (!child) {
        await prisma.childDevice.create({
          data: {
            serialNumber: slave.serial,
            type: slave.type,
            deviceSequence: slave.seq,
            masterId: master.id,
          }
        }).catch(console.warn);
      }
    }

    res.status(201).json(gate);
  } catch (error) {
    next(error);
  }
});

// Get all LC Gates with their masters (strictly scoped to assigned scope groups and child hierarchy)
router.get('/', authenticate, async (req: any, res, next) => {
  try {
    const isDeveloper = req.user?.role === 'Developer';

    // 1. Fetch user's assigned scope groups
    const userScopes = await prisma.scopeGroupUser.findMany({
      where: { userId: req.user.id },
      select: { scopeGroupId: true }
    });
    const assignedScopeGroupIds = userScopes.map(s => s.scopeGroupId);

    let whereClause: any = {};

    if (assignedScopeGroupIds.length > 0) {
      // User is explicitly assigned to Scope Group(s)!
      // Recursively resolve all accessible child scope groups
      const accessibleScopeGroupIds = await getAllDescendantScopeGroupIds(assignedScopeGroupIds);
      let targetScopeIds = accessibleScopeGroupIds;

      // Scoping filter if requested in query
      if (req.query.scopeGroupId) {
        if (req.query.scopeGroupId === 'all') {
          targetScopeIds = isDeveloper ? [] : accessibleScopeGroupIds;
        } else {
          const paramId = parseInt(req.query.scopeGroupId as string, 10);
          if (!isNaN(paramId)) {
            if (!isDeveloper && !accessibleScopeGroupIds.includes(paramId)) {
              // Forbidden: User does not have access to this scope group
              return res.json([]);
            }
            if (req.query.directOnly === 'true') {
              targetScopeIds = [paramId];
            } else {
              targetScopeIds = await getAllDescendantScopeGroupIds([paramId]);
            }
          }
        }
      }

      if (targetScopeIds.length > 0) {
        whereClause.scopeGroups = {
          some: {
            scopeGroupId: { in: targetScopeIds }
          }
        };
      }
    } else {
      // User has NO scope groups assigned
      if (isDeveloper) {
        // Developer with no specific scope assigned has global access
        if (req.query.scopeGroupId && req.query.scopeGroupId !== 'all') {
          const paramId = parseInt(req.query.scopeGroupId as string, 10);
          if (!isNaN(paramId)) {
            const ids = req.query.directOnly === 'true' 
              ? [paramId] 
              : await getAllDescendantScopeGroupIds([paramId]);
            whereClause.scopeGroups = {
              some: { scopeGroupId: { in: ids } }
            };
          }
        }
      } else {
        // Non-developer with no scope assigned sees NO gates
        return res.json([]);
      }
    }

    const gates = await prisma.lCGate.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        deviceRegistries: true,
        scopeGroups: {
          include: {
            scopeGroup: {
              select: { 
                id: true, 
                name: true, 
                color: true,
                parentId: true,
                parent: { select: { id: true, name: true, color: true } }
              }
            }
          }
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
    res.json(gates);
  } catch (error) {
    next(error);
  }
});

// Get next available master sequence for a gate
router.get('/:gateId/next-master-sequence', authenticate, async (req, res, next) => {
  try {
    const gateId = parseInt(req.params.gateId);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });
    
    const lastMaster = await prisma.masterUnit.findFirst({
      where: { gateId },
      orderBy: { masterSequence: 'desc' }
    });
    
    const nextSeq = lastMaster ? lastMaster.masterSequence + 1 : 1;
    res.json({ nextSequence: nextSeq });
  } catch (error) {
    next(error);
  }
});

const createMasterSchema = z.object({
  masterSequence: z.number().int().min(1).max(99).optional(),
  powerSource: z.enum(['SOLAR', 'DIRECT']),
  serialNumber: z.string().optional(),
  deviceId: z.number().int().optional().nullable(),
});

// Add a Master to an LC Gate
router.post('/:gateId/masters', authenticate, async (req, res, next) => {
  try {
    const gateId = parseInt(req.params.gateId);
    if (isNaN(gateId)) return res.status(400).json({ error: 'Invalid gate ID' });
    
    const data = createMasterSchema.parse(req.body);
    
    const gate = await prisma.lCGate.findUnique({ where: { id: gateId } });
    if (!gate) {
      return res.status(404).json({ error: 'LC Gate not found' });
    }

    const existingMasters = await prisma.masterUnit.findMany({
      where: { gateId },
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

    let serialNumber = data.serialNumber ? data.serialNumber.trim() : `${gate.lcNumber}-${targetSequence.toString().padStart(2, '0')}`;
    if (!data.serialNumber) {
      while (await prisma.masterUnit.findUnique({ where: { serialNumber } })) {
        targetSequence++;
        serialNumber = `${gate.lcNumber}-${targetSequence.toString().padStart(2, '0')}`;
      }
    } else {
      const existing = await prisma.masterUnit.findUnique({ where: { serialNumber } });
      if (existing) {
        return res.status(400).json({ error: `Master Unit with serial number "${serialNumber}" already exists` });
      }
    }

    const master = await prisma.masterUnit.create({
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

    // Auto-link DeviceRegistry
    if (data.deviceId) {
      await prisma.deviceRegistry.updateMany({
        where: { id: data.deviceId },
        data: { masterId: master.id, gateId: master.gateId }
      }).catch(console.warn);
    } else {
      await prisma.deviceRegistry.updateMany({
        where: {
          OR: [{ thingName: serialNumber }, { serialNumber: serialNumber }]
        },
        data: { masterId: master.id, gateId: master.gateId }
      }).catch(console.warn);
    }

    res.status(201).json(master);
  } catch (error) {
    next(error);
  }
});

// Get next available device sequence for a master
router.get('/masters/:masterId/next-device-sequence', authenticate, async (req, res, next) => {
  try {
    const masterId = parseInt(req.params.masterId);
    if (isNaN(masterId)) return res.status(400).json({ error: 'Invalid master ID' });

    const master = await prisma.masterUnit.findUnique({ where: { id: masterId } });
    if (!master) return res.status(404).json({ error: 'Master Unit not found' });
    
    const type = (req.query.type as string) || 'DEVICE_1';
    const letter = type === 'DEVICE_1' ? 'A' : 'B';
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
  type: z.enum(['DEVICE_1', 'DEVICE_2']),
  deviceSequence: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? undefined : Number(val)),
    z.number().int().min(1).max(999).optional()
  ),
  serialNumber: z.string().optional(),
  deviceId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
});

// Add a Child Device to a Master
router.post('/masters/:masterId/devices', authenticate, async (req, res, next) => {
  try {
    const masterId = parseInt(req.params.masterId);
    if (isNaN(masterId)) return res.status(400).json({ error: 'Invalid master ID' });
    
    const data = createDeviceSchema.parse(req.body);
    
    const master = await prisma.masterUnit.findUnique({ where: { id: masterId } });
    if (!master) {
      return res.status(404).json({ error: 'Master Unit not found' });
    }

    const letter = data.type === 'DEVICE_1' ? 'A' : 'B';
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

    const device = await prisma.childDevice.create({
      data: {
        type: data.type,
        serialNumber,
        deviceSequence: targetSequence,
        masterId,
      },
    });

    // Auto-link DeviceRegistry
    if (data.deviceId) {
      await prisma.deviceRegistry.updateMany({
        where: { id: data.deviceId },
        data: { childDeviceId: device.id, masterId: master.id, gateId: master.gateId }
      }).catch(console.warn);
    } else {
      await prisma.deviceRegistry.updateMany({
        where: {
          OR: [{ thingName: serialNumber }, { serialNumber: serialNumber }]
        },
        data: { childDeviceId: device.id, masterId: master.id, gateId: master.gateId }
      }).catch(console.warn);
    }

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
    
    await prisma.masterUnit.delete({ where: { id } });
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
    
    await prisma.childDevice.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Get single LC Gate with masters, childDevices, and evidences
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

    const gate = await prisma.lCGate.findUnique({
      where: { id },
      include: {
        deviceRegistries: true,
        scopeGroups: {
          include: {
            scopeGroup: {
              select: { id: true, name: true, color: true }
            }
          }
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
      }
    });

    if (!gate) return res.status(404).json({ error: 'Gate not found' });
    res.json(gate);
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

  return {
    cluster: {
      id: gate.id,
      lcNumber: gate.lcNumber,
      name: gate.name || gate.locationName,
      locationName: gate.locationName,
      zone: gate.zone,
      division: gate.division,
      latitude: gate.latitude,
      longitude: gate.longitude,
      powerSource: isSolar ? 'SOLAR' : 'DIRECT',
      mastersCount: masterList.length,
      slavesCount: slavesList.length,
      masters: mastersWithRegistry,
      slaves: slavesList,
      deviceRegistries: registeredDevices,
    },
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
router.get('/:id/telemetry', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });

    const gate = await prisma.lCGate.findUnique({
      where: { id },
      include: {
        scopeGroups: {
          include: {
            scopeGroup: {
              select: { id: true, name: true, color: true }
            }
          }
        },
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
    // Collect all possible thing / serial identifiers for this gate
    const thingIdentifiers = Array.from(new Set([
      gate.lcNumber,
      ...gate.masters.map(m => m.serialNumber),
      ...gate.deviceRegistries.map(d => d.thingName),
      ...gate.deviceRegistries.map(d => d.serialNumber).filter(Boolean) as string[],
    ])).filter(Boolean);

    const deviceRegistryIds = gate.deviceRegistries.map(d => d.id);

    // Fetch real device telemetry payloads from database
    const telemetries = await prisma.deviceTelemetry.findMany({
      where: {
        OR: [
          { thingName: { in: thingIdentifiers } },
          ...(deviceRegistryIds.length > 0 ? [{ deviceRegistryId: { in: deviceRegistryIds } }] : [])
        ]
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    }).catch(() => []);

    // Categorize payloads:
    // 1. Telemetry
    const telemetryRecords = telemetries.filter(t =>
      (t.topic && t.topic.includes('/telemetry')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).Status !== undefined || (t.payload as any).LimitSwitchClosed !== undefined))
    );

    // 2. Manifest
    const manifestRecords = telemetries.filter(t =>
      (t.topic && t.topic.includes('/manifest')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).thing !== undefined || (t.payload as any).Master !== undefined))
    );

    // 3. Health Check
    const healthRecords = telemetries.filter(t =>
      (t.topic && t.topic.includes('/health')) ||
      (t.payload && typeof t.payload === 'object' && ((t.payload as any).action === 'HEALTH_CHECK' || (t.payload as any).NetworkStrength !== undefined || (t.payload as any).BatteryPercentage !== undefined))
    );

    const latestTele = telemetryRecords[0]?.payload as any;
    const currentStatus = latestTele?.Status || (gate.deviceRegistries[0]?.status ?? 'CONFIGURED');
    const primaryThingName = gate.masters[0]?.serialNumber || gate.deviceRegistries[0]?.thingName || gate.lcNumber;

    const telemetryData = buildGateTelemetry(gate);
    res.json({
      success: true,
      gateId: gate.id,
      lcNumber: gate.lcNumber,
      locationName: gate.locationName,
      thingName: primaryThingName,
      currentStatus,
      topic: `lc-gate/${primaryThingName}/telemetry`,
      counts: {
        all: telemetries.length,
        telemetry: telemetryRecords.length,
        manifest: manifestRecords.length,
        healthCheck: healthRecords.length,
      },
      payloads: telemetries,
      telemetryRecords,
      manifestRecords,
      healthRecords,
      latestTelemetry: telemetryRecords[0] || null,
      latestManifest: manifestRecords[0] || null,
      latestHealthCheck: healthRecords[0] || null,
      cluster: telemetryData.cluster,
      awsConfig: telemetryData.awsConfig,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// Delete an LC Gate (cascades) - declared last so it doesn't shadow the paths above.
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
          mqttDelivery: mqttResult.success ? 'PUBLISHED_TO_BROKER' : 'QUEUED_LOCAL',
          mqttError: mqttResult.error || null,
        },
        status: 'REQUESTED',
        deviceRegistryId: gate.deviceRegistries[0]?.id || null,
        receivedAt: new Date(),
      }
    });

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

// Delete an LC Gate (cascades) - declared last so it doesn't shadow the paths above.
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid gate ID' });
    
    await prisma.lCGate.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
