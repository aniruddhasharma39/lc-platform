import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.get('/roles', async (req, res, next) => {
  try {
    const roles = await prisma.role.findMany();
    res.json(roles);
  } catch (error) {
    next(error);
  }
});

router.use(authenticate);


router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      include: { role: true, requestedRole: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(users);
  } catch (error) {
    next(error);
  }
});

const approveSchema = z.object({
  roleId: z.number().int(),
});

router.put('/:id/approve', requireAdmin, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = approveSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id },
      data: {
        status: 'APPROVED',
        roleId: data.roleId,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'APPROVE_USER',
        details: `Approved user ${id} with role ${data.roleId}`,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

const rejectSchema = z.object({
  reason: z.string().optional(),
});

router.put('/:id/reject', requireAdmin, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = rejectSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: data.reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'REJECT_USER',
        details: `Rejected user ${id}`,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

router.put('/:id/deactivate', requireAdmin, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const user = await prisma.user.update({
      where: { id },
      data: {
        status: 'DEACTIVATED',
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DEACTIVATE_USER',
        details: `Deactivated user ${id}`,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

router.put('/:id/reactivate', requireAdmin, async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const user = await prisma.user.update({
      where: { id },
      data: {
        status: 'APPROVED',
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'REACTIVATE_USER',
        details: `Reactivated user ${id}`,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

export default router;
