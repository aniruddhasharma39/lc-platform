import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';
import { extractRegistrationUserFields } from '../lib/userExtract';
import { bumpDirectoryRevision } from '../lib/revisionManager';
import { clusterCacheManager } from '../lib/clusterCacheManager';
import { canApproveRequest, getDesignationConfig, DESIGNATIONS } from '../lib/railwayHierarchy';

const router = Router();

router.use(authenticate);

router.get('/', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const isDeveloper = req.user?.role?.name === 'Developer' || req.user?.roleId === 1;

    // Fetch approver's assigned gates if any
    const approverUserGates = await prisma.userGate.findMany({
      where: { userId: req.user.id },
      select: { gateId: true }
    });
    const approverGateIds = approverUserGates.map(ug => ug.gateId);

    const [users, allPendingRequests, roles, allGates] = await Promise.all([
      prisma.user.findMany({
        include: {
          role: true,
          requestedRole: true,
          station: { select: { id: true, code: true, name: true, division: true, zone: true } },
          assignedGates: {
            include: {
              gate: { select: { id: true, lcNumber: true, locationName: true, name: true } }
            }
          },
          scopeGroups: {
            include: { scopeGroup: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.registrationRequest.findMany({
        where: { status: 'PENDING' },
        include: {
          form: true,
          station: { select: { id: true, code: true, name: true, division: true, zone: true } }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.role.findMany(),
      prisma.lCGate.findMany({
        select: { id: true, lcNumber: true, locationName: true, name: true, stationId: true }
      })
    ]);

    const roleMap = new Map(roles.map(r => [r.id, r.name]));
    const gateMap = new Map(allGates.map(g => [g.id, g]));

    const existingEmails = new Set(users.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean));
    const existingMobiles = new Set(users.map(u => (u.mobile || '').replace(/\D/g, '').slice(-10)).filter(Boolean));
    const existingEmpIds = new Set(users.map(u => (u.employeeId || '').toLowerCase().trim()).filter(Boolean));

    // Check which immediate superiors are currently registered in the system
    // key: `${designation}:${division}`
    const superiorActiveMap = new Set(
      users
        .filter(u => u.status === 'APPROVED' && u.designation && u.division)
        .map(u => `${(u.designation || "").toLowerCase()}:${(u.division || "").toLowerCase()}`)
    );

    // Filter and enhance pending requests based on reporting hierarchy and jurisdiction
    const visiblePendingRequests: any[] = [];

    for (const r of allPendingRequests) {
      let resolvedRoleId = r.requestedRoleId;
      let reqData: any = {};
      if (r.data) {
        try {
          reqData = JSON.parse(r.data);
          if (reqData.roleId) resolvedRoleId = parseInt(reqData.roleId, 10);
          else if (reqData.requestedRoleId) resolvedRoleId = parseInt(reqData.requestedRoleId, 10);
        } catch (_) {}
      }

      const extracted = extractRegistrationUserFields(reqData, r.form?.schema);
      const conflictReasons: string[] = [];

      if (extracted.email && existingEmails.has(extracted.email.toLowerCase().trim())) {
        conflictReasons.push(`Email "${extracted.email}" is already registered`);
      }
      if (extracted.mobile) {
        const cleanMobile = extracted.mobile.replace(/\D/g, '').slice(-10);
        if (existingMobiles.has(cleanMobile)) {
          conflictReasons.push(`Mobile "${cleanMobile}" is already registered`);
        }
      }
      if (extracted.employeeId && existingEmpIds.has(extracted.employeeId.toLowerCase().trim())) {
        conflictReasons.push(`Employee ID "${extracted.employeeId}" is already registered`);
      }

      // Check immediate superior availability
      const targetDesigCfg = getDesignationConfig(r.designation);
      const immediateSuperior = targetDesigCfg ? targetDesigCfg.immediateSuperior : null;
      let immediateSuperiorAvailable = true;
      if (immediateSuperior && r.division) {
        immediateSuperiorAvailable = superiorActiveMap.has(`${immediateSuperior.toLowerCase()}:${r.division.toLowerCase()}`);
      }

      // Check authorization to approve
      const authCheck = canApproveRequest(req.user, r, approverGateIds);

      // Section 8: An authenticated user sees ONLY registration requests they are authorized to review!
      // Developers see all requests, with clear tags for governance intervention / pending superiors
      if (!isDeveloper && !authCheck.allowed) {
        continue;
      }

      // Resolve gate details for requested gate IDs
      const requestedGates = (r.gateIds || []).map(gid => gateMap.get(gid)).filter(Boolean);

      visiblePendingRequests.push({
        ...r,
        department: r.department || reqData.department,
        designation: r.designation || reqData.designation,
        zone: r.zone || reqData.zone,
        division: r.division || reqData.division,
        stationId: r.stationId || (reqData.stationId ? parseInt(reqData.stationId, 10) : null),
        idCardUrl: r.idCardUrl || reqData.idCard || reqData.idCardUrl || reqData.identityCard,
        requestedGates,
        requestedRoleId: resolvedRoleId,
        requestedRoleName: resolvedRoleId ? roleMap.get(resolvedRoleId) || null : null,
        immediateSuperior,
        immediateSuperiorAvailable,
        canApprove: authCheck.allowed,
        isGovernanceIntervention: authCheck.isGovernanceIntervention || false,
        notAllowedReason: authCheck.reason,
        hasConflict: conflictReasons.length > 0,
        conflictReasons,
      });
    }
    
    res.json({ users, pendingRequests: visiblePendingRequests });
  } catch (error) {
    next(error);
  }
});

const approveSchema = z.object({
  roleId: z.number().int(),
  zone: z.string().optional().nullable(),
  division: z.string().optional().nullable(),
  stationId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
});

router.put('/request/:id/approve', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = approveSchema.parse(req.body);

    const request = await prisma.registrationRequest.findUnique({ 
      where: { id },
      include: { form: true }
    });
    if (!request || request.status !== 'PENDING') {
      return res.status(404).json({ error: 'Request not found or not pending' });
    }

    // Verify hierarchical reporting relationship and geographical jurisdiction
    const approverUserGates = await prisma.userGate.findMany({
      where: { userId: req.user.id },
      select: { gateId: true }
    });
    const approverGateIds = approverUserGates.map(ug => ug.gateId);

    const authCheck = canApproveRequest(req.user, request, approverGateIds);
    if (!authCheck.allowed) {
      return res.status(403).json({
        error: authCheck.reason || 'You are not authorized to approve this registration request.'
      });
    }

    // Atomic lock to prevent simultaneous approvals/rejections (Section 8)
    const locked = await prisma.registrationRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        approvedByUserId: req.user.id,
        approvedAt: new Date()
      }
    });

    if (locked.count === 0) {
      return res.status(409).json({
        error: 'This registration request has already been processed by another officer.'
      });
    }

    const formData = JSON.parse(request.data);
    let schema: any = null;
    try {
      if (request.form?.schema) schema = JSON.parse(request.form.schema);
    } catch {}

    const extracted = extractRegistrationUserFields(formData, request.form?.schema);
    const targetEmail = extracted.email || `temp-${Date.now()}@example.com`;
    const targetMobile = extracted.mobile ? extracted.mobile.replace(/\D/g, '').slice(-10) : `${Date.now()}`.slice(-10);
    const targetEmpId = extracted.employeeId || `EMP-${Date.now()}`;
    const targetName = extracted.fullName || 'Unknown';
    const targetDept = extracted.department || 'Unknown';

    // Verify uniqueness against existing users before attempting to approve
    if (extracted.email) {
      const dupEmail = await prisma.user.findFirst({
        where: { email: { equals: extracted.email.trim(), mode: 'insensitive' } }
      });
      if (dupEmail) {
        return res.status(400).json({
          error: `Cannot approve request: A user with Email Address "${extracted.email}" already exists (${dupEmail.fullName}).`
        });
      }
    }

    if (extracted.mobile) {
      const cleanMob = extracted.mobile.replace(/\D/g, '').slice(-10);
      const dupMobile = await prisma.user.findFirst({
        where: { mobile: cleanMob }
      });
      if (dupMobile) {
        return res.status(400).json({
          error: `Cannot approve request: A user with Mobile Number "${cleanMob}" already exists (${dupMobile.fullName}).`
        });
      }
    }

    if (extracted.employeeId) {
      const dupEmp = await prisma.user.findFirst({
        where: { employeeId: { equals: extracted.employeeId.trim(), mode: 'insensitive' } }
      });
      if (dupEmp) {
        return res.status(400).json({
          error: `Cannot approve request: A user with Employee ID "${extracted.employeeId}" already exists (${dupEmp.fullName}).`
        });
      }
    }

    // Map all formData fields to their actual labels for metadata storage
    const mappedMetadata: Record<string, any> = {};
    const allFields: any[] = [];
    if (schema?.fields) {
      const walk = (fields: any[]) => {
        for (const f of fields) {
          if (f.type === 'section' && f.children) walk(f.children);
          else allFields.push(f);
        }
      };
      walk(schema.fields);
    }

    for (const [k, v] of Object.entries(formData)) {
      if (k === 'password') continue;
      const field = allFields.find(f => f.name === k || f.id === k);
      const label = field ? field.label : k;
      mappedMetadata[label] = v;
    }
    
// Resolve role for designation if not explicitly provided
    let finalRoleId = data.roleId;
    const reqDesig = request.designation || formData.designation;
    if (reqDesig) {
      const desigCfg = getDesignationConfig(reqDesig);
      if (desigCfg) {
        const matchedRole = await prisma.role.findFirst({
          where: { name: desigCfg.defaultRoleName }
        });
        if (matchedRole) finalRoleId = matchedRole.id;
      }
    }

    // Create the actual user
    let user;
    try {
      user = await prisma.user.create({
        data: {
          fullName: targetName,
          email: targetEmail,
          mobile: targetMobile,
          employeeId: targetEmpId,
          department: request.department || targetDept,
          designation: reqDesig || null,
          requestedRoleId: request.requestedRoleId,
          roleId: finalRoleId,
          zone: request.zone || data.zone || null,
          division: request.division || data.division || null,
          stationId: request.stationId || data.stationId || null,
          idCardUrl: request.idCardUrl || formData.idCard || formData.idCardUrl || null,
          passwordHash: (formData.password && formData.password.trim().length > 0)
            ? formData.password
            : await bcrypt.hash('123456', 10),
          status: 'APPROVED',
          metadata: JSON.stringify(mappedMetadata)
        }
      });

      // Link explicitly assigned LC Gates in UserGate table (Section 9)
      const gateIdsToAssign: number[] = Array.isArray(request.gateIds) ? request.gateIds : [];
      for (const gId of gateIdsToAssign) {
        await prisma.userGate.upsert({
          where: { userId_gateId: { userId: user.id, gateId: gId } },
          update: {},
          create: { userId: user.id, gateId: gId }
        });
      }
    } catch (err: any) {
      // Revert request status if user creation failed
      await prisma.registrationRequest.update({
        where: { id },
        data: { status: 'PENDING', approvedByUserId: null, approvedAt: null }
      });
      if (err?.code === 'P2002') {
        const target = err.meta?.target || 'unique field';
        return res.status(409).json({
          error: `Cannot approve request: Duplicate conflict on ${Array.isArray(target) ? target.join(', ') : target}.`
        });
      }
      throw err;
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'APPROVE_USER_REQUEST',
        details: `Approved registration request ${id} and created user ${user.id} with role ${data.roleId}`,
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

router.put('/request/:id/reject', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data = rejectSchema.parse(req.body);

    if (!data.reason || data.reason.trim().length === 0) {
      return res.status(400).json({ error: 'A specific reason is mandatory for rejecting an employee registration.' });
    }

    const request = await prisma.registrationRequest.findUnique({ where: { id } });
    if (!request || request.status !== 'PENDING') {
      return res.status(404).json({ error: 'Request not found or already processed.' });
    }

    // Verify hierarchical reporting relationship
    const approverUserGates = await prisma.userGate.findMany({
      where: { userId: req.user.id },
      select: { gateId: true }
    });
    const approverGateIds = approverUserGates.map(ug => ug.gateId);

    const authCheck = canApproveRequest(req.user, request, approverGateIds);
    if (!authCheck.allowed) {
      return res.status(403).json({
        error: authCheck.reason || 'You are not authorized to reject this registration request.'
      });
    }

    const locked = await prisma.registrationRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        rejectionReason: data.reason.trim(),
        approvedByUserId: req.user.id,
        approvedAt: new Date()
      }
    });

    if (locked.count === 0) {
      return res.status(409).json({ error: 'This request was already decided by another officer.' });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'REJECT_USER_REQUEST',
        details: `Rejected registration request ${id} for "${request.designation || 'applicant'}": ${data.reason}`,
      },
    });

    res.json({ success: true, message: 'Registration request rejected.' });
  } catch (error) {
    next(error);
  }
});

// Exceptional escalation route when immediate superior is not registered (Section 7.5)
router.post('/request/:id/escalate', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { reason } = req.body;

    const request = await prisma.registrationRequest.findUnique({ where: { id } });
    if (!request || request.status !== 'PENDING') {
      return res.status(404).json({ error: 'Request not found or already processed.' });
    }

    await prisma.registrationRequest.update({
      where: { id },
      data: {
        isEscalated: true,
        escalationReason: reason || 'Escalated for governance-level review because immediate senior officer is not registered.'
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'ESCALATE_USER_REQUEST',
        details: `Escalated registration request ${id} to governance: ${reason || 'Immediate superior unavailable'}`,
      },
    });

    res.json({ success: true, message: 'Request escalated to governance authority.' });
  } catch (error) {
    next(error);
  }
});

router.put('/:id/deactivate', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        status: 'DEACTIVATED',
      },
    });

    clusterCacheManager.invalidateUser(id);
    await bumpDirectoryRevision([], true);

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

router.put('/:id/reactivate', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const user = await prisma.user.update({
      where: { id },
      data: {
        status: 'APPROVED',
      },
    });

    clusterCacheManager.invalidateUser(id);
    await bumpDirectoryRevision([], true);

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

const railwayMappingSchema = z.object({
  zone: z.string().optional().nullable(),
  division: z.string().optional().nullable(),
  stationId: z.preprocess(
    (val) => (val === '' || val === null || val === undefined ? null : Number(val)),
    z.number().int().optional().nullable()
  ),
});

router.put('/:id/railway-mapping', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' });

    const data = railwayMappingSchema.parse(req.body);
    const updated = await prisma.user.update({
      where: { id },
      data: {
        zone: data.zone !== undefined ? data.zone : undefined,
        division: data.division !== undefined ? data.division : undefined,
        stationId: data.stationId !== undefined ? data.stationId : undefined,
      },
      include: {
        role: true,
        station: true,
        scopeGroups: { include: { scopeGroup: true } }
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'UPDATE_USER_RAILWAY_MAPPING',
        details: `Updated railway mapping for user ${updated.fullName} (Zone: ${updated.zone || 'N/A'}, Div: ${updated.division || 'N/A'}, Station: ${updated.stationId || 'N/A'})`,
      },
    }).catch(console.warn);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });

    if (!existingUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 1. Delete RefreshTokens
    await prisma.refreshToken.deleteMany({ where: { userId: id } }).catch(console.warn);

    // 2. Disconnect audit logs so history remains intact
    await prisma.auditLog.updateMany({
      where: { userId: id },
      data: { userId: null },
    }).catch(console.warn);

    // 3. Remove ScopeGroup memberships

    // 4. Delete associated installation evidences
    await prisma.installationEvidence.deleteMany({ where: { userId: id } }).catch(console.warn);

    // 5. Delete User
    await prisma.user.delete({ where: { id } });

    clusterCacheManager.invalidateUser(id);
    await bumpDirectoryRevision([], true);

    // 6. Record in Audit Log
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DELETE_USER',
        details: `Permanently deleted user ${existingUser.fullName} (${existingUser.email || existingUser.employeeId})`,
      },
    }).catch(console.warn);

    res.json({
      success: true,
      message: `User ${existingUser.fullName} deleted permanently`,
      deletedUser: {
        id: existingUser.id,
        fullName: existingUser.fullName,
        email: existingUser.email,
        employeeId: existingUser.employeeId,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

