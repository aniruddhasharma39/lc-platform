import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

const createGateSchema = z.object({
  name: z.string().optional(),
  lcNumberDigits: z.string().regex(/^\d{4}$/, "Must be exactly 4 digits"),
  locationName: z.string().min(1),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
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
        latitude: data.latitude,
        longitude: data.longitude,
      },
    });
    res.status(201).json(gate);
  } catch (error) {
    next(error);
  }
});

// Get all LC Gates with their masters
router.get('/', authenticate, async (req, res, next) => {
  try {
    const gates = await prisma.lCGate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
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
  masterSequence: z.number().int().min(1).max(99),
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

    const serialNumber = `${gate.lcNumber}-${data.masterSequence.toString().padStart(2, '0')}`;

    const existing = await prisma.masterUnit.findUnique({ where: { serialNumber } });
    if (existing) {
      return res.status(400).json({ error: 'Master unit sequence already exists for this gate' });
    }

    const master = await prisma.masterUnit.create({
      data: {
        serialNumber,
        masterSequence: data.masterSequence,
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
    const lastDevice = await prisma.childDevice.findFirst({
      where: { masterId, ...(type ? { type } : {}) },
      orderBy: { deviceSequence: 'desc' }
    });
    
    const nextSeq = lastDevice ? lastDevice.deviceSequence + 1 : 1;
    res.json({ nextSequence: nextSeq });
  } catch (error) {
    next(error);
  }
});

const createDeviceSchema = z.object({
  type: z.enum(['DEVICE_1', 'DEVICE_2']),
  deviceSequence: z.number().int().min(1).max(99),
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
    const serialNumber = `${master.serialNumber}-${letter}${data.deviceSequence.toString().padStart(2, '0')}`;

    const existing = await prisma.childDevice.findUnique({ where: { serialNumber } });
    if (existing) {
      return res.status(400).json({ error: 'Slave device sequence already exists for this master' });
    }

    const device = await prisma.childDevice.create({
      data: {
        type: data.type,
        serialNumber,
        deviceSequence: data.deviceSequence,
        masterId,
      },
    });

    res.status(201).json(device);
  } catch (error) {
    next(error);
  }
});

// Delete an LC Gate (cascades)
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

// Delete a Master Unit (cascades to devices and evidences)
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

export default router;
