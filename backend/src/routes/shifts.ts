import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

export const DEFAULT_3_SHIFT_CONFIG = {
  name: 'Standard 3-Shift 8hr',
  shifts: [
    { id: 'shift_1', name: 'Morning Shift', startTime: '06:00', endTime: '14:00' },
    { id: 'shift_2', name: 'Evening Shift', startTime: '14:00', endTime: '22:00' },
    { id: 'shift_3', name: 'Night Shift', startTime: '22:00', endTime: '06:00' }
  ]
};

export const DEFAULT_2_SHIFT_CONFIG = {
  name: 'Standard 2-Shift 12hr',
  shifts: [
    { id: 'shift_1', name: 'Day Shift', startTime: '08:00', endTime: '20:00' },
    { id: 'shift_2', name: 'Night Shift', startTime: '20:00', endTime: '08:00' }
  ]
};

const shiftConfigSchema = z.object({
  stationId: z.number().int().optional().nullable(),
  gateId: z.number().int().optional().nullable(),
  name: z.string().min(1, 'Template name is required'),
  shifts: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    name: z.string().min(1, 'Shift name is required'),
    startTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Format must be HH:mm (24hr)'),
    endTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Format must be HH:mm (24hr)'),
  })).min(1, 'At least 1 shift must be defined'),
});

/**
 * GET /api/v1/shifts/config
 * Retrieves active shift configuration for a station or specific gate.
 */
router.get('/config', async (req: any, res, next) => {
  try {
    const stationId = req.query.stationId ? parseInt(req.query.stationId, 10) : undefined;
    const gateId = req.query.gateId ? parseInt(req.query.gateId, 10) : undefined;

    let config: any = null;

    if (gateId) {
      config = await prisma.gateShiftConfig.findFirst({
        where: { gateId },
        orderBy: { updatedAt: 'desc' }
      });
    }

    if (!config && stationId) {
      config = await prisma.gateShiftConfig.findFirst({
        where: { stationId, gateId: null },
        orderBy: { updatedAt: 'desc' }
      });
    }

    if (!config) {
      // Fallback to default 3-shift pattern
      return res.json({
        id: null,
        stationId: stationId || null,
        gateId: gateId || null,
        name: DEFAULT_3_SHIFT_CONFIG.name,
        shifts: DEFAULT_3_SHIFT_CONFIG.shifts,
        isDefault: true,
      });
    }

    let parsedShifts = [];
    try {
      parsedShifts = JSON.parse(config.shiftsJson);
    } catch (_) {
      parsedShifts = DEFAULT_3_SHIFT_CONFIG.shifts;
    }

    return res.json({
      id: config.id,
      stationId: config.stationId,
      gateId: config.gateId,
      name: config.name,
      shifts: parsedShifts,
      isDefault: false,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/shifts/config
 * Saves/updates shift configuration for a station or specific gate.
 */
router.post('/config', async (req: any, res, next) => {
  try {
    const data = shiftConfigSchema.parse(req.body);
    const shiftsJson = JSON.stringify(data.shifts);

    let config;
    if (data.gateId) {
      const existing = await prisma.gateShiftConfig.findFirst({ where: { gateId: data.gateId } });
      if (existing) {
        config = await prisma.gateShiftConfig.update({
          where: { id: existing.id },
          data: { name: data.name, shiftsJson, stationId: data.stationId }
        });
      } else {
        config = await prisma.gateShiftConfig.create({
          data: {
            name: data.name,
            shiftsJson,
            gateId: data.gateId,
            stationId: data.stationId
          }
        });
      }
    } else if (data.stationId) {
      const existing = await prisma.gateShiftConfig.findFirst({
        where: { stationId: data.stationId, gateId: null }
      });
      if (existing) {
        config = await prisma.gateShiftConfig.update({
          where: { id: existing.id },
          data: { name: data.name, shiftsJson }
        });
      } else {
        config = await prisma.gateShiftConfig.create({
          data: {
            name: data.name,
            shiftsJson,
            stationId: data.stationId,
            gateId: null
          }
        });
      }
    } else {
      return res.status(400).json({ error: 'Either stationId or gateId must be provided' });
    }

    res.json({
      success: true,
      config: {
        id: config.id,
        stationId: config.stationId,
        gateId: config.gateId,
        name: config.name,
        shifts: data.shifts
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
