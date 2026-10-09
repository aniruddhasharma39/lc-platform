import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const modules = await prisma.module.findMany({
      orderBy: { name: 'asc' }
    });
    res.json(modules);
  } catch (error) {
    next(error);
  }
});

export default router;
