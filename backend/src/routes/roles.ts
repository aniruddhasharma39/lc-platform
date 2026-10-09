import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// List roles and their module access
router.get('/', async (req, res, next) => {
  try {
    const roles = await prisma.role.findMany({
      include: {
        roleModules: {
          include: { module: true }
        }
      }
    });
    res.json(roles);
  } catch (error) {
    next(error);
  }
});

// Admin/Roles Manager only below
router.use(requireModule('roles'));

const roleSchema = z.object({
  name: z.string().min(1),
  moduleIds: z.array(z.number().int()),
});

router.post('/', async (req, res, next) => {
  try {
    const data = roleSchema.parse(req.body);
    
    // Check if role exists
    const existing = await prisma.role.findUnique({ where: { name: data.name } });
    if (existing) {
      return res.status(400).json({ error: 'Role already exists' });
    }

    const role = await prisma.role.create({
      data: {
        name: data.name,
        roleModules: {
          create: data.moduleIds.map(id => ({ moduleId: id }))
        }
      },
      include: {
        roleModules: { include: { module: true } }
      }
    });

    res.status(201).json(role);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = roleSchema.parse(req.body);

    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    
    if (role.name === 'Developer') {
      return res.status(403).json({ error: 'Cannot modify Developer role' });
    }

    // Delete existing roleModules
    await prisma.roleModule.deleteMany({
      where: { roleId: id }
    });

    // Create new roleModules
    const updatedRole = await prisma.role.update({
      where: { id },
      data: {
        name: data.name,
        roleModules: {
          create: data.moduleIds.map(modId => ({ moduleId: modId }))
        }
      },
      include: {
        roleModules: { include: { module: true } }
      }
    });

    res.json(updatedRole);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    
    const role = await prisma.role.findUnique({ 
      where: { id },
      include: { _count: { select: { users: true } } } 
    });
    
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }
    
    if (role.name === 'Developer') {
      return res.status(403).json({ error: 'Cannot delete Developer role' });
    }

    if (role._count.users > 0) {
      return res.status(400).json({ error: 'Cannot delete role that has assigned users' });
    }

    await prisma.role.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
