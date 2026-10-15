import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.use(authenticate);

const CANONICAL_ORDER = ['lc-gates', 'branding', 'cluster', 'scope-groups', 'manage-users', 'registration', 'roles'];

router.get('/', async (req, res, next) => {
  try {
    // Ensure LC Gates module exists
    await prisma.module.upsert({
      where: { slug: 'lc-gates' },
      update: {},
      create: { name: 'LC Gates', slug: 'lc-gates' }
    });

    const modules = await prisma.module.findMany();
    modules.sort((a, b) => {
      let idxA = CANONICAL_ORDER.indexOf(a.slug);
      let idxB = CANONICAL_ORDER.indexOf(b.slug);
      if (idxA === -1) idxA = 999;
      if (idxB === -1) idxB = 999;
      if (idxA !== idxB) return idxA - idxB;
      return a.name.localeCompare(b.name);
    });
    res.json(modules);
  } catch (error) {
    next(error);
  }
});

export default router;
