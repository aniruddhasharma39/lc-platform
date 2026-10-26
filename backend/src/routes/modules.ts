import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireAdmin } from '../middleware/auth';

const router = Router();

router.use(authenticate);

const CANONICAL_ORDER = [
  'lc-gates',
  'cluster',
  'devices',
  'scope-groups',
  'manage-users',
  'registration',
  'roles',
  'branding',
];

const REQUIRED_MODULES = [
  { name: 'LC Gates', slug: 'lc-gates' },
  { name: 'Cluster', slug: 'cluster' },
  { name: 'Device Registry', slug: 'devices' },
  { name: 'Scope Groups', slug: 'scope-groups' },
  { name: 'Manage Users', slug: 'manage-users' },
  { name: 'Registration Builder', slug: 'registration' },
  { name: 'Roles', slug: 'roles' },
  { name: 'Branding', slug: 'branding' },
];

router.get('/', async (req, res, next) => {
  try {
    // Ensure all required system modules exist in DB
    for (const mod of REQUIRED_MODULES) {
      await prisma.module.upsert({
        where: { slug: mod.slug },
        update: {},
        create: { name: mod.name, slug: mod.slug }
      });
    }

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
