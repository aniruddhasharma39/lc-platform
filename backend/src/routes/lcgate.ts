import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { RAILWAY_DATA, RAILWAY_ZONES, divisionsForZone } from '../lib/railwayData';
import { getAllDescendantScopeGroupIds } from '../lib/scopeHierarchy';

const router = Router();

const createGateSchema = z.object({
  name: z.string().nullable().optional(),
  lcNumberDigits: z.string().regex(/^\d{4}$/, "Must be exactly 4 digits"),
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
    const lcNumber = `LC-${data.lcNumberDigits}`;
    
    // Check for existing gate
    const existing = await prisma.lCGate.findUnique({ where: { lcNumber } });
    if (existing) {
      return res.status(400).json({ error: 'Gate with this LC Number already exists' });
    }

    const gate = await prisma.lCGate.create({
      data: {
        name: data.name,
        lcNumber,
        locationName: data.locationName,
        zone: data.zone,
        division: data.division,
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });
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

    let serialNumber = `${gate.lcNumber}-${targetSequence.toString().padStart(2, '0')}`;
    while (await prisma.masterUnit.findUnique({ where: { serialNumber } })) {
      targetSequence++;
      serialNumber = `${gate.lcNumber}-${targetSequence.toString().padStart(2, '0')}`;
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
    
    const type = req.query.type as string;
    const existing = await prisma.childDevice.findMany({
      where: { masterId, ...(type ? { type } : {}) },
      select: { deviceSequence: true }
    });
    
    const taken = new Set(existing.map(d => d.deviceSequence));
    let nextSeq = 1;
    while (taken.has(nextSeq)) {
      nextSeq++;
    }
    res.json({ nextSequence: nextSeq });
  } catch (error) {
    next(error);
  }
});

const createDeviceSchema = z.object({
  type: z.enum(['DEVICE_1', 'DEVICE_2']),
  deviceSequence: z.number().int().min(1).max(99).optional(),
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

    // Find all existing child devices for this master to inspect existing sequences
    const existingDevices = await prisma.childDevice.findMany({
      where: { masterId, type: data.type },
      select: { deviceSequence: true, serialNumber: true }
    });

    const takenSequences = new Set(existingDevices.map(d => d.deviceSequence));
    
    let targetSequence = data.deviceSequence;
    // If no sequence provided or if the requested sequence is already taken on this master, auto-calculate the next available
    if (!targetSequence || takenSequences.has(targetSequence)) {
      let nextSeq = 1;
      while (takenSequences.has(nextSeq)) {
        nextSeq++;
      }
      targetSequence = nextSeq;
    }

    // Ensure serialNumber is unique globally
    let serialNumber = `${master.serialNumber}-${letter}${targetSequence.toString().padStart(2, '0')}`;
    let existingSerial = await prisma.childDevice.findUnique({ where: { serialNumber } });
    while (existingSerial) {
      targetSequence++;
      serialNumber = `${master.serialNumber}-${letter}${targetSequence.toString().padStart(2, '0')}`;
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
  const now = new Date();

  const slavesList: any[] = [];
  masterList.forEach((m: any) => {
    (m.childDevices || []).forEach((c: any) => {
      slavesList.push({
        id: c.id,
        serialNumber: c.serialNumber,
        type: c.type,
        sequence: c.deviceSequence,
        status: 'PENDING_FLEET_MAPPING'
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
      masters: masterList
    },
    awsConfig: {
      provisioningMode: 'AWS_FLEET_PROVISIONING',
      region: 'ap-south-1 (Mumbai)',
      status: 'FLEET_MAPPING_PENDING',
      description: 'Physical hardware devices will be mapped with AWS IoT Core via Fleet Provisioning.'
    },
    timestamp: now.toISOString()
  };
}

// Get AWS Fleet Provisioning & Device Status for a Gate
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
    const telemetryData = buildGateTelemetry(gate);
    res.json(telemetryData);
  } catch (error) {
    next(error);
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
