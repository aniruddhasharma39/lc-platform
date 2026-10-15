import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';
import { extractRegistrationUserFields } from '../lib/userExtract';

const router = Router();

router.use(authenticate);

router.get('/', requireModule('manage-users'), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        role: true,
        requestedRole: true,
        scopeGroups: {
          include: { scopeGroup: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const [pendingRequests, roles] = await Promise.all([
      prisma.registrationRequest.findMany({
        where: { status: 'PENDING' },
        include: { form: true },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.role.findMany()
    ]);

    const roleMap = new Map(roles.map(r => [r.id, r.name]));

    const existingEmails = new Set(users.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean));
    const existingMobiles = new Set(users.map(u => (u.mobile || '').replace(/\D/g, '').slice(-10)).filter(Boolean));
    const existingEmpIds = new Set(users.map(u => (u.employeeId || '').toLowerCase().trim()).filter(Boolean));

    const enhancedPendingRequests = pendingRequests.map(r => {
      let resolvedRoleId = r.requestedRoleId;
      let reqData: any = {};
      if (r.data) {
        try {
          reqData = JSON.parse(r.data);
          if (reqData.roleId) resolvedRoleId = parseInt(reqData.roleId);
          else if (reqData.requestedRoleId) resolvedRoleId = parseInt(reqData.requestedRoleId);
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

      return {
        ...r,
        requestedRoleId: resolvedRoleId,
        requestedRoleName: resolvedRoleId ? roleMap.get(resolvedRoleId) || null : null,
        hasConflict: conflictReasons.length > 0,
        conflictReasons,
      };
    });
    
    res.json({ users, pendingRequests: enhancedPendingRequests });
  } catch (error) {
    next(error);
  }
});

const approveSchema = z.object({
  roleId: z.number().int(),
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
    
// Create the actual user
    let user;
    try {
      user = await prisma.user.create({
        data: {
          fullName: targetName,
          email: targetEmail,
          mobile: targetMobile,
          employeeId: targetEmpId,
          department: targetDept,
          requestedRoleId: request.requestedRoleId,
          roleId: data.roleId,
          passwordHash: (formData.password && formData.password.trim().length > 0)
            ? formData.password
            : await bcrypt.hash('123456', 10),
          status: 'APPROVED',
          metadata: JSON.stringify(mappedMetadata)
        }
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const target = err.meta?.target || 'unique field';
        return res.status(409).json({
          error: `Cannot approve request: Duplicate conflict on ${Array.isArray(target) ? target.join(', ') : target}.`
        });
      }
      throw err;
    }

    await prisma.registrationRequest.update({
      where: { id },
      data: { status: 'APPROVED' }
    });

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

    await prisma.registrationRequest.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: data.reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'REJECT_USER_REQUEST',
        details: `Rejected registration request ${id}`,
      },
    });

    res.json({ success: true });
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
