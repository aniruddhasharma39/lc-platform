import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule, AuthRequest } from '../middleware/auth';
import { getAllDescendantScopeGroupIds, wouldCreateCycle, getScopeGroupBreadcrumbs } from '../lib/scopeHierarchy';

const router = Router();

router.use(authenticate);

// 1. Get calling user's assigned scopes & accessible gate IDs (with recursive hierarchy resolution)
router.get('/my-scope', async (req: AuthRequest, res, next) => {
  try {
    const isDeveloper = req.user?.role === 'Developer';
    
    // Check actual assigned scope groups for this user
    const userScopeRecords = await prisma.scopeGroupUser.findMany({
      where: { userId: req.user!.id },
      include: {
        scopeGroup: {
          include: {
            parent: { select: { id: true, name: true, color: true } },
            children: { select: { id: true, name: true, color: true, parentId: true } },
            gates: { select: { gateId: true } }
          }
        }
      }
    });

    const directScopeGroupIds = userScopeRecords.map(r => r.scopeGroup.id);

    // If user has assigned scope groups, resolve all descendant groups (folders within folders)
    if (directScopeGroupIds.length > 0) {
      const allAccessibleIds = await getAllDescendantScopeGroupIds(directScopeGroupIds);

      // Fetch all accessible scope groups in the full tree
      const allAccessibleGroups = await prisma.scopeGroup.findMany({
        where: { id: { in: allAccessibleIds } },
        include: {
          parent: { select: { id: true, name: true, color: true } },
          children: {
            select: {
              id: true,
              name: true,
              color: true,
              parentId: true,
              _count: { select: { gates: true, children: true } }
            }
          },
          gates: { select: { gateId: true } },
          _count: { select: { gates: true, children: true } }
        }
      });

      const gateIdSet = new Set<number>();
      allAccessibleGroups.forEach(g => {
        g.gates.forEach(item => gateIdSet.add(item.gateId));
      });

      // Top-level assigned groups for this user (roots of their access)
      const assignedGroups = userScopeRecords.map(r => {
        const fullGroup = allAccessibleGroups.find(g => g.id === r.scopeGroup.id) || r.scopeGroup;
        return {
          id: fullGroup.id,
          name: fullGroup.name,
          color: fullGroup.color,
          description: fullGroup.description,
          parentId: (fullGroup as any).parentId || null,
          parent: (fullGroup as any).parent || null,
          directGateCount: fullGroup.gates?.length || 0,
          subGroupCount: (fullGroup as any).children?.length || 0,
          children: (fullGroup as any).children || [],
        };
      });

      return res.json({
        isDeveloper,
        scopeGroups: assignedGroups,
        allScopeGroups: allAccessibleGroups,
        accessibleGateIds: Array.from(gateIdSet),
        allAccess: false,
        hasAssignedScopes: true
      });
    }

    // If Developer has NO specific scope groups assigned, they have full access
    if (isDeveloper) {
      const allGroups = await prisma.scopeGroup.findMany({
        include: {
          parent: { select: { id: true, name: true, color: true } },
          children: {
            select: {
              id: true,
              name: true,
              color: true,
              parentId: true,
              _count: { select: { gates: true, children: true } }
            }
          },
          gates: { select: { gateId: true } },
          _count: { select: { gates: true, children: true } }
        }
      });

      const allGates = await prisma.lCGate.findMany({ select: { id: true } });
      const allGateIds = allGates.map(g => g.id);

      return res.json({
        isDeveloper: true,
        scopeGroups: allGroups.filter(g => !g.parentId), // root groups
        allScopeGroups: allGroups,
        accessibleGateIds: allGateIds,
        allAccess: true,
        hasAssignedScopes: false
      });
    }

    // Regular user with no assigned scopes
    res.json({
      isDeveloper: false,
      scopeGroups: [],
      allScopeGroups: [],
      accessibleGateIds: [],
      allAccess: false,
      hasAssignedScopes: false
    });
  } catch (error) {
    next(error);
  }
});

// Admin / Scope Manager guard helper
const requireScopeAdmin = async (req: AuthRequest, res: any, next: any) => {
  try {
    if (req.user?.role !== 'Developer') {
      return res.status(403).json({ error: 'Forbidden: Only administrators can create, edit, or delete scope groups' });
    }
    // Check if user is restricted by being assigned to a scope group
    const assignedCount = await prisma.scopeGroupUser.count({
      where: { userId: req.user!.id }
    });
    if (assignedCount > 0) {
      return res.status(403).json({ error: 'Forbidden: Assigned scope members have read-only access and cannot create or modify scope groups' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// 2. List Scope Groups (Admins see all; assigned users see their assigned scope group and all child groups)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const isDeveloper = req.user?.role === 'Developer';
    const assignedUserRecords = await prisma.scopeGroupUser.findMany({
      where: { userId: req.user!.id },
      select: { scopeGroupId: true }
    });
    const hasAssignedScopes = assignedUserRecords.length > 0;

    // Check access permission
    if (!isDeveloper && !hasAssignedScopes && !req.user?.allowedModules.includes('scope-groups')) {
      return res.status(403).json({ error: 'Forbidden: Access to Scope Groups required' });
    }

    const whereClause: any = {};
    if (hasAssignedScopes) {
      const allAccessibleIds = await getAllDescendantScopeGroupIds(assignedUserRecords.map(r => r.scopeGroupId));
      whereClause.id = { in: allAccessibleIds };
    }

    // Optional filter by parentId
    if (req.query.parentId !== undefined) {
      if (req.query.parentId === 'root' || req.query.parentId === 'null') {
        whereClause.parentId = null;
      } else {
        const pId = parseInt(req.query.parentId as string, 10);
        if (!isNaN(pId)) {
          whereClause.parentId = pId;
        }
      }
    }

    const groups = await prisma.scopeGroup.findMany({
      where: whereClause,
      orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
      include: {
        parent: {
          select: { id: true, name: true, color: true, parentId: true }
        },
        children: {
          select: {
            id: true,
            name: true,
            color: true,
            parentId: true,
            _count: { select: { gates: true, children: true } }
          }
        },
        _count: {
          select: { gates: true, users: true, children: true }
        },
        gates: {
          include: {
            gate: {
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
              }
            }
          }
        },
        users: hasAssignedScopes ? false : {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                mobile: true,
                department: true,
                status: true,
                role: { select: { id: true, name: true } }
              }
            }
          }
        }
      }
    });

    res.json(groups);
  } catch (error) {
    next(error);
  }
});

// 2b. Get Breadcrumbs for Scope Group ID
router.get('/:id/breadcrumbs', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid scope group ID' });
    const crumbs = await getScopeGroupBreadcrumbs(id);
    res.json(crumbs);
  } catch (error) {
    next(error);
  }
});

// 3. Get single Scope Group by ID
router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid scope group ID' });

    const isDeveloper = req.user?.role === 'Developer';
    const assignedUserRecords = await prisma.scopeGroupUser.findMany({
      where: { userId: req.user!.id },
      select: { scopeGroupId: true }
    });
    const hasAssignedScopes = assignedUserRecords.length > 0;

    if (hasAssignedScopes) {
      const accessibleIds = await getAllDescendantScopeGroupIds(assignedUserRecords.map(r => r.scopeGroupId));
      if (!accessibleIds.includes(id)) {
        return res.status(403).json({ error: 'Forbidden: You do not have access to this scope group' });
      }
    }

    const group = await prisma.scopeGroup.findUnique({
      where: { id },
      include: {
        parent: {
          select: { id: true, name: true, color: true, parentId: true }
        },
        children: {
          select: {
            id: true,
            name: true,
            color: true,
            parentId: true,
            _count: { select: { gates: true, children: true } }
          }
        },
        _count: {
          select: { gates: true, users: true, children: true }
        },
        gates: {
          include: {
            gate: {
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
              }
            }
          }
        },
        users: hasAssignedScopes ? false : {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                mobile: true,
                department: true,
                status: true,
                role: { select: { id: true, name: true } }
              }
            }
          }
        }
      }
    });

    if (!group) return res.status(404).json({ error: 'Scope Group not found' });
    const breadcrumbs = await getScopeGroupBreadcrumbs(id);
    res.json({ ...group, breadcrumbs });
  } catch (error) {
    next(error);
  }
});

const scopeGroupSchema = z.object({
  name: z.string().min(1, 'Scope Group name is required').max(100),
  description: z.string().optional().nullable(),
  color: z.string().regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Invalid hex color').optional().nullable(),
  parentId: z.number().int().optional().nullable(),
  gateIds: z.array(z.number().int()).optional(),
  userIds: z.array(z.number().int()).optional(),
  subGroupNames: z.array(z.string().min(1).max(100)).optional(),
});

// 4. Create Scope Group (with optional sub-groups defined simultaneously)
router.post('/', requireScopeAdmin, async (req: AuthRequest, res, next) => {
  try {
    const data = scopeGroupSchema.parse(req.body);
    const existing = await prisma.scopeGroup.findUnique({ where: { name: data.name } });
    if (existing) {
      return res.status(400).json({ error: 'A Scope Group with this name already exists' });
    }

    if (data.parentId) {
      const parentGroup = await prisma.scopeGroup.findUnique({ where: { id: data.parentId } });
      if (!parentGroup) {
        return res.status(400).json({ error: 'Selected parent Scope Group does not exist' });
      }
    }

    const gateIds = Array.from(new Set(data.gateIds || []));
    const userIds = Array.from(new Set(data.userIds || []));
    const subGroupNames = (data.subGroupNames || []).map(s => s.trim()).filter(Boolean);

    const group = await prisma.$transaction(async (tx) => {
      const created = await tx.scopeGroup.create({
        data: {
          name: data.name,
          description: data.description || null,
          color: data.color || '#0B3C7A',
          parentId: data.parentId ?? null,
          gates: {
            create: gateIds.map(gateId => ({ gateId }))
          },
          users: {
            create: userIds.map(userId => ({ userId }))
          }
        }
      });

      // Simultaneously create any initial child sub-groups defined with this parent
      for (const sgName of subGroupNames) {
        const existingSub = await tx.scopeGroup.findUnique({ where: { name: sgName } });
        if (!existingSub) {
          await tx.scopeGroup.create({
            data: {
              name: sgName,
              description: `Sub-division of ${created.name}`,
              color: created.color,
              parentId: created.id
            }
          });
        } else if (existingSub.parentId === null) {
          await tx.scopeGroup.update({
            where: { id: existingSub.id },
            data: { parentId: created.id }
          });
        }
      }

      return tx.scopeGroup.findUnique({
        where: { id: created.id },
        include: {
          parent: { select: { id: true, name: true, color: true, parentId: true } },
          children: {
            select: {
              id: true,
              name: true,
              color: true,
              parentId: true,
              description: true,
              gates: { include: { gate: true } },
              _count: { select: { gates: true, children: true } }
            }
          },
          _count: { select: { gates: true, users: true, children: true } },
          gates: { include: { gate: true } },
          users: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  mobile: true,
                  department: true,
                  role: true
                }
              }
            }
          }
        }
      });
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'CREATE_SCOPE_GROUP',
        details: `Created scope group "${group!.name}" (Parent: ${data.parentId ?? 'None'}) with ${gateIds.length} gates, ${userIds.length} users, and ${subGroupNames.length} sub-groups`
      }
    });

    res.status(201).json(group);
  } catch (error) {
    next(error);
  }
});

// 5. Update Scope Group
router.put('/:id', requireScopeAdmin, async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid scope group ID' });

    const data = scopeGroupSchema.parse(req.body);

    const existing = await prisma.scopeGroup.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Scope Group not found' });

    // Check unique name if changing
    if (data.name !== existing.name) {
      const nameConflict = await prisma.scopeGroup.findUnique({ where: { name: data.name } });
      if (nameConflict) {
        return res.status(400).json({ error: 'Another Scope Group with this name already exists' });
      }
    }

    // Cycle check if parentId changed
    if (data.parentId !== undefined && data.parentId !== null) {
      if (data.parentId === id) {
        return res.status(400).json({ error: 'A Scope Group cannot be its own parent' });
      }
      const parentGroup = await prisma.scopeGroup.findUnique({ where: { id: data.parentId } });
      if (!parentGroup) {
        return res.status(400).json({ error: 'Selected parent Scope Group does not exist' });
      }
      const createsCycle = await wouldCreateCycle(id, data.parentId);
      if (createsCycle) {
        return res.status(400).json({ error: 'Cannot set parent: would create a circular hierarchy loop' });
      }
    }

    const gateIds = data.gateIds ? Array.from(new Set(data.gateIds)) : undefined;
    const userIds = data.userIds ? Array.from(new Set(data.userIds)) : undefined;
    const subGroupNames = (data.subGroupNames || []).map(s => s.trim()).filter(Boolean);

    const updated = await prisma.$transaction(async (tx) => {
      // Update basic fields
      await tx.scopeGroup.update({
        where: { id },
        data: {
          name: data.name,
          description: data.description !== undefined ? data.description : existing.description,
          color: data.color !== undefined ? data.color : existing.color,
          parentId: data.parentId !== undefined ? data.parentId : existing.parentId,
        }
      });

      // Create any new sub-groups passed
      for (const sgName of subGroupNames) {
        const existingSub = await tx.scopeGroup.findUnique({ where: { name: sgName } });
        if (!existingSub) {
          await tx.scopeGroup.create({
            data: {
              name: sgName,
              description: `Sub-division of ${data.name}`,
              color: data.color || existing.color,
              parentId: id
            }
          });
        } else if (existingSub.parentId === null && existingSub.id !== id) {
          await tx.scopeGroup.update({
            where: { id: existingSub.id },
            data: { parentId: id }
          });
        }
      }

      // Sync gates if provided
      if (gateIds !== undefined) {
        await tx.scopeGroupGate.deleteMany({ where: { scopeGroupId: id } });
        if (gateIds.length > 0) {
          await tx.scopeGroupGate.createMany({
            data: gateIds.map(gateId => ({ scopeGroupId: id, gateId }))
          });
        }
      }

      // Sync users if provided
      if (userIds !== undefined) {
        await tx.scopeGroupUser.deleteMany({ where: { scopeGroupId: id } });
        if (userIds.length > 0) {
          await tx.scopeGroupUser.createMany({
            data: userIds.map(userId => ({ scopeGroupId: id, userId }))
          });
        }
      }

      return tx.scopeGroup.findUnique({
        where: { id },
        include: {
          parent: { select: { id: true, name: true, color: true, parentId: true } },
          children: {
            select: {
              id: true,
              name: true,
              color: true,
              parentId: true,
              description: true,
              gates: { include: { gate: true } },
              _count: { select: { gates: true, children: true } }
            }
          },
          _count: { select: { gates: true, users: true, children: true } },
          gates: { include: { gate: true } },
          users: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  email: true,
                  mobile: true,
                  department: true,
                  role: true
                }
              }
            }
          }
        }
      });
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'UPDATE_SCOPE_GROUP',
        details: `Updated scope group "${data.name}" (ID: ${id})`
      }
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

// 6. Delete Scope Group
router.delete('/:id', requireScopeAdmin, async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid scope group ID' });

    const existing = await prisma.scopeGroup.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Scope Group not found' });

    await prisma.scopeGroup.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'DELETE_SCOPE_GROUP',
        details: `Deleted scope group "${existing.name}" (ID: ${id})`
      }
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// 7. Update scopes assigned to a specific user (Convenience endpoint for Manage Users)
router.put('/user/:userId', requireScopeAdmin, async (req: AuthRequest, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const bodySchema = z.object({
      scopeGroupIds: z.array(z.number().int())
    });
    const { scopeGroupIds } = bodySchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const cleanScopeIds = Array.from(new Set(scopeGroupIds));

    await prisma.$transaction(async (tx) => {
      await tx.scopeGroupUser.deleteMany({ where: { userId } });
      if (cleanScopeIds.length > 0) {
        await tx.scopeGroupUser.createMany({
          data: cleanScopeIds.map(scopeGroupId => ({ userId, scopeGroupId }))
        });
      }
    });

    const updatedUserScopes = await prisma.scopeGroupUser.findMany({
      where: { userId },
      include: { scopeGroup: true }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.id,
        action: 'ASSIGN_USER_SCOPES',
        details: `Assigned user ${user.fullName} (${userId}) to ${cleanScopeIds.length} scope groups`
      }
    });

    res.json({
      userId,
      scopeGroups: updatedUserScopes.map(s => s.scopeGroup)
    });
  } catch (error) {
    next(error);
  }
});

export default router;
