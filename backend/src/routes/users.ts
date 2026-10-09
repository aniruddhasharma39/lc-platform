import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/', requireModule('manage-users'), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      include: { role: true, requestedRole: true },
      orderBy: { createdAt: 'desc' }
    });
    
    const pendingRequests = await prisma.registrationRequest.findMany({
      where: { status: 'PENDING' },
      include: { form: true },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({ users, pendingRequests });
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

    const extract = (keywords: string[]): string | undefined => {
      // First check if direct key exists
      for (const kw of keywords) {
        if (formData[kw]) return formData[kw];
      }
      
      // Then check schema labels
      if (!schema?.fields) return undefined;
      const allFields: any[] = [];
      const walk = (fields: any[]) => {
        for (const f of fields) {
          if (f.type === 'section' && f.children) walk(f.children);
          else allFields.push(f);
        }
      };
      walk(schema.fields);
      
      for (const f of allFields) {
        const label = (f.label || '').toLowerCase();
        if (keywords.some(kw => label.includes(kw))) {
          if (formData[f.name]) return formData[f.name];
        }
      }
      return undefined;
    };
    
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
      const field = allFields.find(f => f.name === k);
      const label = field ? field.label : k;
      mappedMetadata[label] = v;
    }
    
    // Create the actual user
    const user = await prisma.user.create({
      data: {
        fullName: extract(['name', 'fullname']) || 'Unknown',
        email: extract(['email']) || `temp-${Date.now()}@example.com`,
        mobile: extract(['phone', 'mobile', 'contact']) || `${Date.now()}`.slice(-10),
        employeeId: extract(['emp', 'employee id']) || `EMP-${Date.now()}`,
        department: extract(['department', 'dept', 'designation']) || 'Unknown',
        requestedRoleId: request.requestedRoleId,
        roleId: data.roleId,
        passwordHash: formData.password || '', // password was hashed in auth.ts
        status: 'APPROVED',
        metadata: JSON.stringify(mappedMetadata)
      }
    });

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
