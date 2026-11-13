import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireModule } from '../middleware/auth';
import { extractRegistrationUserFields } from '../lib/userExtract';
import { bumpDirectoryRevision } from '../lib/revisionManager';
import { clusterCacheManager } from '../lib/clusterCacheManager';
import {
  canApproveRequest,
  canAssignRole,
  getAllowedRoleNamesForApprover,
  getDesignationConfig,
  DESIGNATIONS,
  buildUserManagementWhereClause,
  isDeveloperUser,
  verifyUserManagementAccess,
} from '../lib/railwayHierarchy';
import { sendRegistrationApprovalEmail, sendRegistrationRejectionEmail } from '../lib/emailService';

const router = Router();

router.use(authenticate);

router.get('/', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const isDeveloper = isDeveloperUser(req.user);

    // Retrieve full viewer record for reliable hierarchy evaluation
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true }
    });
    const viewer = currentUser || req.user;

    // Fetch approver's assigned gates if any
    const approverUserGates = await prisma.userGate.findMany({
      where: { userId: req.user.id },
      select: { gateId: true }
    });
    const approverGateIds = approverUserGates.map(ug => ug.gateId);

    // Build role hierarchy filter for existing users
    const userWhereClause = await buildUserManagementWhereClause(viewer, prisma);

    const [users, allPendingRequests, roles, allGates] = await Promise.all([
      prisma.user.findMany({
        where: userWhereClause,
        include: {
          role: true,
          requestedRole: true,
          station: { select: { id: true, code: true, name: true, division: true, zone: true } },
          assignedGates: {
            include: {
              gate: { select: { id: true, lcNumber: true, locationName: true, name: true } }
            }
          },
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
      const authCheck = canApproveRequest(viewer, r, approverGateIds);

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
        allowedRoleNames: getAllowedRoleNamesForApprover(viewer),
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
  gateIds: z.array(z.number().int()).optional(),
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

    // Verify target role authorization (Subordinate-only, Developer restricted to Developer)
    const targetRole = await prisma.role.findUnique({ where: { id: data.roleId } });
    if (!targetRole) {
      return res.status(400).json({ error: 'Selected role does not exist.' });
    }

    const roleCheck = canAssignRole(req.user, targetRole.id, targetRole.name);
    if (!roleCheck.allowed) {
      return res.status(403).json({
        error: roleCheck.reason || 'You do not have hierarchical authority to assign this role.'
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
    
    // Role assignment authorization:
    // Only Developer / Admin has the right to explicitly select/override a role.
    // Non-developer approvers strictly approve the applicant's requested role.
    const isApproverDeveloper = isDeveloperUser(req.user);
    const reqDesig = request.designation || formData.designation;
    let finalRoleId: number | null = null;

    if (isApproverDeveloper && data.roleId && data.roleId > 0) {
      // Developer explicitly selected/assigned this role
      finalRoleId = data.roleId;
    } else {
      // For all other users (or Developer approving default): strictly honor applicant's requested role
      if (request.requestedRoleId) {
        finalRoleId = request.requestedRoleId;
      } else if (reqDesig) {
        const desigCfg = getDesignationConfig(reqDesig);
        if (desigCfg) {
          const matchedRole = await prisma.role.findFirst({
            where: { name: desigCfg.defaultRoleName }
          });
          if (matchedRole) finalRoleId = matchedRole.id;
        }
      }
      if (!finalRoleId && data.roleId) {
        finalRoleId = data.roleId;
      }
    }

    if (!finalRoleId) {
      return res.status(400).json({ error: 'Cannot approve: Unable to resolve a valid role for this registration request.' });
    }

    // Create the actual user with relation to role included
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
          requestedRoleId: request.requestedRoleId || finalRoleId,
          roleId: finalRoleId,
          zone: request.zone || data.zone || null,
          division: request.division || data.division || null,
          stationId: request.stationId || data.stationId || null,
          idCardUrl: request.idCardUrl || formData.idCard || formData.idCardUrl || null,
          passwordHash: (formData.password && formData.password.trim().length > 0)
            ? await bcrypt.hash(formData.password.trim(), 10)
            : await bcrypt.hash('123456', 10),
          status: 'APPROVED',
          metadata: JSON.stringify(mappedMetadata)
        },
        include: {
          role: true,
          station: { select: { id: true, name: true, code: true } }
        }
      });

      // Link explicitly assigned LC Gates in UserGate table (Section 9)
      const gateIdsToAssign: number[] = (data.gateIds && Array.isArray(data.gateIds) && data.gateIds.length > 0)
        ? data.gateIds
        : (Array.isArray(request.gateIds) ? request.gateIds : []);
      for (const gId of gateIdsToAssign) {
        await prisma.userGate.upsert({
          where: { userId_gateId: { userId: user.id, gateId: gId } },
          update: {},
          create: { userId: user.id, gateId: gId }
        });
      }

      // Dispatch Official Registration Approval Email (Strictly Email only, clean & direct)
      if (user.email && user.email.includes('@') && user.email.includes('.')) {
        (async () => {
          try {
            await sendRegistrationApprovalEmail({
              toEmail: user.email.trim(),
              recipientName: user.fullName || 'Railway Staff',
              roleName: user.role?.name || user.designation || 'Officer',
              department: user.department || 'Engineering',
              division: user.division || '-',
              zone: user.zone || '-'
            });
            console.log("✉️ [REGISTRATION APPROVAL] Sent approval email to " + user.email + " (" + user.fullName + ")");
          } catch (emailErr: any) {
            console.error('⚠️ [REGISTRATION APPROVAL] Error sending approval email:', emailErr?.message || emailErr);
          }
        })();
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

    const reasonText = data.reason?.trim() || '';
    if (reasonText.length === 0) {
      return res.status(400).json({ error: 'A specific reason is mandatory for rejecting an employee registration.' });
    }

    const request = await prisma.registrationRequest.findUnique({
      where: { id },
      include: { form: true },
    });
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

    let reqData: any = {};
    try {
      reqData = JSON.parse(request.data || '{}');
    } catch (_) {}

    const extracted = extractRegistrationUserFields(reqData, request.form?.schema);
    const applicantName = (extracted.fullName || reqData.fullName || reqData.name || 'Applicant').toString().trim();
    const applicantEmail = (extracted.email || reqData.email || '').toString().trim();
    const applicantMobile = (extracted.mobile || reqData.mobile || '').toString().replace(/\D/g, '').slice(-10);
    const applicantEmpId = (extracted.employeeId || reqData.employeeId || '').toString().trim();
    const applicantDept = (request.department || extracted.department || reqData.department || 'Railway Operations').toString().trim();

    let resolvedRoleName = request.designation || '';
    const effectiveRoleId = request.requestedRoleId || (reqData.roleId ? parseInt(reqData.roleId, 10) : (reqData.requestedRoleId ? parseInt(reqData.requestedRoleId, 10) : null));
    if (!resolvedRoleName && effectiveRoleId && !isNaN(effectiveRoleId)) {
      const roleRow = await prisma.role.findUnique({ where: { id: effectiveRoleId }, select: { name: true } });
      if (roleRow?.name) resolvedRoleName = roleRow.name;
    }
    if (!resolvedRoleName) resolvedRoleName = 'Applicant';

    // Atomically delete PENDING request so the applicant is immediately unblocked to submit a brand-new application
    const deleted = await prisma.registrationRequest.deleteMany({
      where: { id, status: 'PENDING' },
    });

    if (deleted.count === 0) {
      return res.status(409).json({ error: 'This request was already decided by another officer.' });
    }

    // Clear stale OTP verifications for this mobile number so re-registration starts completely fresh
    if (applicantMobile.length === 10) {
      await prisma.otpVerification.deleteMany({
        where: { identifier: applicantMobile, type: 'PHONE' },
      }).catch(() => {});
    }

    // Preserve permanent audit record before returning
    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'REJECT_USER_REQUEST',
        details: `Rejected and cleared registration request #${id} for "${applicantName}" (${resolvedRoleName}, Mobile: ${applicantMobile || 'N/A'}, Email: ${applicantEmail || 'N/A'}, EmpID: ${applicantEmpId || 'N/A'}). Reason: ${reasonText}`,
      },
    });

    // Dispatch official Rejection Email explaining the exact reason
    let emailSent = false;
    let emailError: string | null = null;
    if (applicantEmail && applicantEmail.includes('@') && applicantEmail.includes('.')) {
      try {
        const mailResult = await sendRegistrationRejectionEmail({
          toEmail: applicantEmail,
          recipientName: applicantName,
          rejectionReason: reasonText,
          roleName: resolvedRoleName,
          department: applicantDept,
          division: request.division || reqData.division || '-',
          zone: request.zone || reqData.zone || '-',
        });
        emailSent = mailResult.success;
        if (!mailResult.success) {
          emailError = mailResult.error || 'Email delivery failed';
          console.warn(`⚠️ [REGISTRATION REJECTION] Could not deliver rejection email to ${applicantEmail}:`, emailError);
        } else {
          console.log(`✉️ [REGISTRATION REJECTION] Sent rejection email to ${applicantEmail} (${applicantName})`);
        }
      } catch (emailErr: any) {
        emailError = emailErr?.message || 'Unexpected email dispatch error';
        console.error('⚠️ [REGISTRATION REJECTION] Error sending rejection email:', emailError);
      }
    }

    res.json({
      success: true,
      message: emailSent
        ? `Registration rejected and cleared. Rejection email sent to ${applicantEmail}.`
        : 'Registration rejected and cleared.',
      emailSent,
      recipientEmail: applicantEmail || null,
      emailError,
    });
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

    const targetUser = await prisma.user.findUnique({
      where: { id },
      include: { role: true },
    });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.role?.name === 'Developer') {
      return res.status(400).json({ error: 'Developer accounts cannot be deactivated' });
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
    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

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
      },
    });

    clusterCacheManager.invalidateUser(id);
    await bumpDirectoryRevision([], true);

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireModule('manage-users'), async (req: any, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    // Only Developer role is authorized to permanently purge users
    if (!isDeveloperUser(req.user)) {
      return res.status(403).json({
        error: 'Permanent user deletion is restricted strictly to Developer console. You may deactivate this user instead.'
      });
    }

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

    if (existingUser.role?.name === 'Developer') {
      return res.status(400).json({ error: 'Developer accounts cannot be deleted' });
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

