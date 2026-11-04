import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { send2FactorSmsOtp } from '../lib/twofactor';
import { sendEmailOtp } from '../lib/emailService';
import { extractRegistrationUserFields, checkRegistrationUniqueness } from '../lib/userExtract';
import { validateRegistrationUniqueness } from '../lib/uniqueness';
import { DEPARTMENTS, DESIGNATIONS, getDesignationConfig, getDesignationsForDepartment } from '../lib/railwayHierarchy';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

router.get('/installed-hierarchy', async (req, res, next) => {
  try {
    const gates = await prisma.lCGate.findMany({
      select: {
        id: true,
        lcNumber: true,
        name: true,
        locationName: true,
        zone: true,
        division: true,
        stationId: true,
        station: {
          select: {
            id: true,
            code: true,
            name: true,
            division: true,
            zone: true,
          }
        }
      },
      orderBy: { lcNumber: 'asc' }
    });

    // Group only geographical units that have actual LC Gate installations
    const zoneMap = new Map<string, Map<string, Map<string, any>>>();

    for (const g of gates) {
      const zoneName = (g.zone || g.station?.zone || 'Unassigned Zone').trim();
      const divName = (g.division || g.station?.division || 'Unassigned Division').trim();

      let divMap = zoneMap.get(zoneName);
      if (!divMap) {
        divMap = new Map();
        zoneMap.set(zoneName, divMap);
      }

      let stMap = divMap.get(divName);
      if (!stMap) {
        stMap = new Map();
        divMap.set(divName, stMap);
      }

      const stId = g.station ? g.station.id : null;
      const stKey = stId ? `station-${stId}` : `loc-${g.locationName || g.id}`;

      let stEntry = stMap.get(stKey);
      if (!stEntry) {
        stEntry = {
          id: stId,
          code: g.station ? g.station.code : 'GATE-LOC',
          name: g.station ? g.station.name : (g.locationName || g.lcNumber),
          gates: []
        };
        stMap.set(stKey, stEntry);
      }

      stEntry.gates.push({
        id: g.id,
        lcNumber: g.lcNumber,
        name: g.name || g.lcNumber,
        locationName: g.locationName,
      });
    }

    const zones = Array.from(zoneMap.entries()).map(([zoneName, divMap]) => ({
      name: zoneName,
      divisions: Array.from(divMap.entries()).map(([divName, stMap]) => ({
        name: divName,
        stations: Array.from(stMap.values())
      }))
    }));

    const departments = DEPARTMENTS.map(deptName => ({
      name: deptName,
      designations: getDesignationsForDepartment(deptName).map(d => ({
        name: d.name,
        seniority: d.seniority,
        level: d.level,
        maxGates: d.maxGates,
        immediateSuperior: d.immediateSuperior,
        description: d.description,
      }))
    }));

    res.json({ zones, departments });
  } catch (err) {
    next(err);
  }
});

router.post('/check-availability', async (req, res, next) => {
  try {
    const { email, mobile, employeeId, formId } = req.body;
    let schemaStr: string | null = null;
    if (formId) {
      const form = await prisma.registrationForm.findUnique({ where: { id: parseInt(formId) } });
      if (form) schemaStr = form.schema;
    }
    const result = await checkRegistrationUniqueness({ email, mobile, employeeId }, undefined, schemaStr);
    res.json({
      available: !result.hasConflict,
      ...result
    });
  } catch (err) {
    next(err);
  }
});

router.post('/register', upload.any(), async (req, res, next) => {
  try {
    let parsedData: any;
    let requestedRoleId: number = -1;
    let formId: number;

    // Support both application/json and multipart/form-data
    if (req.is('multipart/form-data')) {
      parsedData = JSON.parse(req.body.data);
      requestedRoleId = req.body.roleId ? parseInt(req.body.roleId) : (req.body.requestedRoleId ? parseInt(req.body.requestedRoleId) : -1);
      formId = parseInt(req.body.formId);
    } else {
      parsedData = req.body.data;
      requestedRoleId = req.body.requestedRoleId ? parseInt(req.body.requestedRoleId) : (req.body.roleId ? parseInt(req.body.roleId) : -1);
      formId = req.body.formId;
    }

    if (requestedRoleId === -1 && parsedData && typeof parsedData === 'object') {
      if (parsedData.roleId !== undefined && parsedData.roleId !== null) {
        requestedRoleId = parseInt(parsedData.roleId);
      } else if (parsedData.requestedRoleId !== undefined && parsedData.requestedRoleId !== null) {
        requestedRoleId = parseInt(parsedData.requestedRoleId);
      }
    }

    if (!formId) return res.status(400).json({ error: 'Missing formId' });

    // Verify form is LIVE
    const form = await prisma.registrationForm.findUnique({ where: { id: formId } });
    if (!form || form.status !== 'LIVE') {
      return res.status(400).json({ error: 'Invalid or inactive registration form' });
    }

    // Verify Uniqueness Constraints (Primary identity fields & builder-specified unique fields)
    const uniquenessResult = await validateRegistrationUniqueness(form.schema, parsedData);
    if (!uniquenessResult.isValid) {
      const firstConflict = uniquenessResult.conflicts?.[0];
      return res.status(409).json({
        error: uniquenessResult.error,
        conflicts: uniquenessResult.conflicts,
        conflictType: firstConflict?.field,
        conflictSource: firstConflict?.source === 'PENDING_REQUEST' ? 'pending_request' : 'active_user'
      });
    }

    // Additional check with normalized extraction against existing users & pending requests
    const extractedFields = extractRegistrationUserFields(parsedData, form.schema);
    const uniquenessCheck = await checkRegistrationUniqueness(extractedFields, undefined, form.schema);
    if (uniquenessCheck.hasConflict) {
      return res.status(409).json({
        error: uniquenessCheck.errorMessage || 'A user with matching credentials already exists.',
        conflictType: uniquenessCheck.conflictType,
        conflictSource: uniquenessCheck.conflictSource
      });
    }

    // Upload files to Cloudinary with safe base64 fallback
    let idCardUploadedUrl = parsedData.idCard || parsedData.idCardUrl || null;
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        let fileUrl = '';
        if (process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_CLOUD_NAME) {
          try {
            fileUrl = await new Promise<string>((resolve, reject) => {
              const stream = cloudinary.uploader.upload_stream(
                { folder: 'lc-platform-registration' },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result!.secure_url);
                }
              );
              stream.end(file.buffer);
            });
          } catch (uploadErr) {
            console.warn('Cloudinary upload failed, falling back to data URL:', uploadErr);
            fileUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
          }
        } else {
          fileUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        }
        parsedData[file.fieldname] = fileUrl;
        if (file.fieldname === 'idCard' || file.fieldname === 'idCardUrl' || file.fieldname === 'identityCard') {
          idCardUploadedUrl = fileUrl;
        }
      }
    }

    // Extract railway organization fields
    const department = (parsedData.department || req.body.department || '').trim();
    const designation = (parsedData.designation || req.body.designation || '').trim();
    const zone = (parsedData.zone || req.body.zone || '').trim();
    const division = (parsedData.division || req.body.division || '').trim();
    const stationIdRaw = parsedData.stationId !== undefined ? parsedData.stationId : req.body.stationId;
    const stationId = (stationIdRaw !== null && stationIdRaw !== undefined && stationIdRaw !== '') ? parseInt(stationIdRaw, 10) : null;
    
    let gateIds: number[] = [];
    if (parsedData.gateIds) {
      gateIds = Array.isArray(parsedData.gateIds)
        ? parsedData.gateIds.map((id: any) => parseInt(id, 10)).filter((n: number) => !isNaN(n))
        : [parseInt(parsedData.gateIds, 10)].filter((n: number) => !isNaN(n));
    } else if (req.body.gateIds) {
      gateIds = Array.isArray(req.body.gateIds)
        ? req.body.gateIds.map((id: any) => parseInt(id, 10)).filter((n: number) => !isNaN(n))
        : [parseInt(req.body.gateIds, 10)].filter((n: number) => !isNaN(n));
    }

    const declarationConfirmed = Boolean(parsedData.declarationConfirmed ?? req.body.declarationConfirmed ?? false);

    // Validate Official Railway Department & Designation
    const desigCfg = getDesignationConfig(designation);
    if (designation && !desigCfg) {
      return res.status(400).json({ error: `Invalid railway designation "${designation}". Please select an official designation.` });
    }

    if (desigCfg) {
      if (department && department.toLowerCase() !== desigCfg.department.toLowerCase()) {
        return res.status(400).json({ error: `Designation "${designation}" belongs to ${desigCfg.department} department, not ${department}.` });
      }

      // Enforce station requirement for station/gate level roles
      if ((desigCfg.level === 'STATION' || desigCfg.level === 'GATE') && !stationId) {
        return res.status(400).json({ error: `Station selection is mandatory for ${designation}.` });
      }

      // Enforce Gateman strictly ONE gate rule (Section 4.2 & 9)
      if (desigCfg.name === 'Gateman') {
        if (!Array.isArray(gateIds) || gateIds.length !== 1) {
          return res.status(400).json({ error: 'A Gateman must be assigned to exactly ONE Level Crossing Gate.' });
        }
      }

      // Enforce Station Master & Engineering Supervisor multiple/single gate requirement
      if (desigCfg.name === 'Station Master' || desigCfg.name === 'Engineering Supervisor') {
        if (!Array.isArray(gateIds) || gateIds.length === 0) {
          return res.status(400).json({ error: `At least one Level Crossing Gate under the selected station must be assigned for ${designation}.` });
        }
      }

      // Enforce mandatory security and verification declaration (Section 6)
      if (!declarationConfirmed) {
        return res.status(400).json({ error: 'You must confirm the official security declaration stating that all submitted information is accurate.' });
      }

      // Enforce Identity Document upload
      if (!idCardUploadedUrl && !parsedData.idCard && !parsedData.identityCard) {
        return res.status(400).json({ error: 'Official Railway Identity Document upload is mandatory for registration.' });
      }

      // Resolve matching role ID from designation
      const matchedRole = await prisma.role.findFirst({
        where: { name: desigCfg.defaultRoleName }
      });
      if (matchedRole) {
        requestedRoleId = matchedRole.id;
      }
    }

    // Hash password if it exists in data
    let dataToStore = { ...parsedData };
    if (dataToStore.password) {
      dataToStore.password = await bcrypt.hash(dataToStore.password, 10);
    }

    const request = await prisma.registrationRequest.create({
      data: {
        formId,
        data: JSON.stringify(dataToStore),
        requestedRoleId: requestedRoleId !== -1 ? requestedRoleId : null,
        department: department || (desigCfg ? desigCfg.department : null),
        designation: desigCfg ? desigCfg.name : designation || null,
        zone: zone || null,
        division: division || null,
        stationId: stationId || null,
        gateIds: gateIds,
        idCardUrl: idCardUploadedUrl || null,
        declarationConfirmed: declarationConfirmed,
        status: 'PENDING'
      }
    });

    res.status(201).json({ message: 'Registration submitted, pending approval.', requestId: request.id });
  } catch (error) {
    next(error);
  }
});

router.get('/registration-form', async (req, res, next) => {
  try {
    let form = await prisma.registrationForm.findFirst({
      where: { status: 'LIVE' }
    });
    
    if (!form) {
      const defaultSchema = {
        fields: [
          { id: '1', type: 'text', name: 'fullName', label: 'Full Name', required: true, placeholder: 'Enter your full name' },
          { id: '2', type: 'phone', name: 'mobile', label: 'Mobile Number', required: true, unique: true, placeholder: '10-digit mobile number' },
          { id: '3', type: 'email', name: 'email', label: 'Email Address', required: true, unique: true, placeholder: 'name@example.com' },
          { id: '4', type: 'text', name: 'employeeId', label: 'Employee ID', required: true, unique: true, placeholder: 'e.g. EMP-101' },
          { id: '5', type: 'text', name: 'department', label: 'Department', required: true, placeholder: 'e.g. Engineering' },
          { id: '6', type: 'password', name: 'password', label: 'Password', required: true, placeholder: 'Create a password' }
        ],
        allowRoles: true
      };

      form = await prisma.registrationForm.create({
        data: {
          name: 'Standard Registration Form',
          schema: JSON.stringify(defaultSchema),
          status: 'LIVE',
          version: 1
        }
      });
    }
    
    let hasEmailField = true;
    let hasPhoneField = true;
    try {
      const parsed = JSON.parse(form.schema);
      const fieldsList = Array.isArray(parsed) ? parsed : (parsed.fields || []);
      const fieldTypes = fieldsList.map((f: any) => f.type);
      hasEmailField = fieldTypes.includes('email');
      hasPhoneField = fieldTypes.includes('phone');
    } catch {}

    const roles = await prisma.role.findMany({
      where: { name: { not: 'Developer' } } // Don't allow registering as Developer
    });
    
    res.json({ form, roles, hasEmailField, hasPhoneField });
  } catch (error) {
    console.warn('Database temporarily unreachable for registration form, returning standard form fallback:', error);
    const defaultSchema = {
      fields: [
        { id: '1', type: 'text', name: 'fullName', label: 'Full Name', required: true, placeholder: 'Enter your full name' },
        { id: '2', type: 'phone', name: 'mobile', label: 'Mobile Number', required: true, unique: true, placeholder: '10-digit mobile number' },
        { id: '3', type: 'email', name: 'email', label: 'Email Address', required: true, unique: true, placeholder: 'name@example.com' },
        { id: '4', type: 'text', name: 'employeeId', label: 'Employee ID', required: true, unique: true, placeholder: 'e.g. EMP-101' },
        { id: '5', type: 'text', name: 'department', label: 'Department', required: true, placeholder: 'e.g. Engineering' },
        { id: '6', type: 'password', name: 'password', label: 'Password', required: true, placeholder: 'Create a password' }
      ],
      allowRoles: true
    };
    const defaultRoles = [
      { id: 2, name: 'Zone Officer' },
      { id: 3, name: 'Division Officer' },
      { id: 4, name: 'Section / Station Master' },
      { id: 5, name: 'Gatesman' }
    ];
    res.json({
      form: { id: 1, name: 'Standard Registration Form', schema: JSON.stringify(defaultSchema), status: 'LIVE' },
      roles: defaultRoles,
      hasEmailField: true,
      hasPhoneField: true
    });
  }
});

async function findMatchingRegistrationRequest(identifier: string) {
  const cleanId = identifier.trim().toLowerCase();
  const digitsOnly = identifier.replace(/\D/g, '').slice(-10);

  const requests = await prisma.registrationRequest.findMany({
    where: {
      status: { in: ['PENDING', 'REJECTED', 'ESCALATED'] }
    },
    orderBy: { createdAt: 'desc' }
  });

  for (const req of requests) {
    if (!req.data) continue;
    try {
      const pData = JSON.parse(req.data);
      const email = (pData.email || '').trim().toLowerCase();
      const mobile = (pData.mobile || '').replace(/\D/g, '').slice(-10);
      const employeeId = (pData.employeeId || '').trim().toLowerCase();

      if (
        (email && email === cleanId) ||
        (digitsOnly && digitsOnly.length === 10 && mobile === digitsOnly) ||
        (employeeId && employeeId === cleanId)
      ) {
        return { req, pData };
      }
    } catch {}
  }
  return null;
}

async function createSession(user: any) {
  const secret = process.env.JWT_SECRET || 'super-secret-jwt-key';
  const refreshSecret = process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-key';
  
  const tokenExpiresIn = (process.env.JWT_EXPIRES_IN || '90d') as any;
  const refreshExpiresIn = (process.env.JWT_REFRESH_EXPIRES_IN || '180d') as any;

  const token = jwt.sign({ userId: user.id }, secret, { expiresIn: tokenExpiresIn });
  const refreshToken = jwt.sign({ userId: user.id }, refreshSecret, { expiresIn: refreshExpiresIn });

  const refreshDays = parseInt((process.env.JWT_REFRESH_EXPIRES_IN || '180').replace(/\D/g, ''), 10) || 180;
  const expiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt,
    },
  });

  let allowedModules = user.role?.roleModules?.map((rm: any) => rm.module?.slug) || [];
  const roleName = user.role?.name;
  if (roleName === 'Developer' || roleName?.toLowerCase() === 'developer') {
    const allModules = await prisma.module.findMany();
    allowedModules = allModules.map((m: any) => m.slug);
  }

  return {
    token,
    refreshToken,
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      mobile: user.mobile,
      employeeId: user.employeeId,
      department: user.department,
      role: user.role?.name,
      metadata: user.metadata,
      createdAt: user.createdAt,
      mustChangePassword: user.mustChangePassword,
      allowedModules
    }
  };
}

router.post('/login', async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);

    const cleanIdentifier = data.identifier.trim();

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: cleanIdentifier, mode: 'insensitive' } },
          { mobile: cleanIdentifier },
          { employeeId: { equals: cleanIdentifier, mode: 'insensitive' } },
        ],
      },
      include: { 
        role: {
          include: {
            roleModules: {
              include: { module: true }
            }
          }
        } 
      },
    });

    if (!user) {
      const pendingMatch = await findMatchingRegistrationRequest(cleanIdentifier);
      if (pendingMatch) {
        const { req: matchReq, pData } = pendingMatch;
        if (matchReq.status === 'PENDING' || matchReq.status === 'ESCALATED') {
          return res.status(403).json({
            error: 'Your account registration is currently pending supervisor approval. You will be able to log in once your application is reviewed and approved.',
            registrationPending: true,
            requestId: matchReq.id,
            status: matchReq.status,
            applicantName: pData.fullName || 'Applicant'
          });
        }
        if (matchReq.status === 'REJECTED') {
          return res.status(403).json({
            error: `Your registration request was rejected by your supervisor.${matchReq.rejectionReason ? ` Reason: ${matchReq.rejectionReason}` : ''}`,
            registrationRejected: true,
            rejectionReason: matchReq.rejectionReason
          });
        }
      }
      return res.status(401).json({ error: 'Invalid credentials. If you are a new applicant, please register first.' });
    }

    if (user.status === 'PENDING') {
      return res.status(403).json({
        error: 'Your account registration is currently pending supervisor approval. You will be able to log in once approved.',
        registrationPending: true
      });
    }

    if (user.status === 'REJECTED') {
      return res.status(403).json({ error: `Account rejected. Reason: ${user.rejectionReason || 'None given'}` });
    }

    if (user.status === 'DEACTIVATED') {
      return res.status(403).json({ error: 'Account deactivated' });
    }

    if (user.lockoutUntil && user.lockoutUntil > new Date()) {
      return res.status(403).json({ error: 'Account locked out after repeated failures' });
    }

    const validPassword = await bcrypt.compare(data.password, user.passwordHash);

    if (!validPassword) {
      const attempts = user.failedLoginAttempts + 1;
      let lockoutUntil = null;
      if (attempts >= 5) {
        lockoutUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes lockout
      }
      
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts, lockoutUntil },
      });

      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockoutUntil: null },
    });

    const session = await createSession(user);
    res.json(session);
  } catch (error) {
    next(error);
  }
});

const sendOtpSchema = z.object({
  type: z.enum(['email', 'phone']),
  identifier: z.string().min(1),
});

// Send OTP for Login / Forgot Password
router.post('/otp/send', async (req, res, next) => {
  try {
    const { type, identifier } = sendOtpSchema.parse(req.body);
    const cleanId = identifier.trim();

    // Validation
    if (type === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanId)) {
        return res.status(400).json({ error: 'Please enter a valid email address with @ and domain.' });
      }
    } else {
      const digitsOnly = cleanId.replace(/\D/g, '');
      const indianPhoneRegex = /^[6-9]\d{9}$/;
      if (!indianPhoneRegex.test(digitsOnly)) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.' });
      }
    }

    let user: any = null;
    if (type === 'email') {
      user = await prisma.user.findFirst({
        where: { email: { equals: cleanId, mode: 'insensitive' } }
      });

      if (!user) {
        const pendingMatch = await findMatchingRegistrationRequest(cleanId);
        if (pendingMatch) {
          if (pendingMatch.req.status === 'PENDING' || pendingMatch.req.status === 'ESCALATED') {
            return res.status(403).json({
              error: 'Your registration is currently pending supervisor approval. You will be able to log in once approved.',
              registrationPending: true
            });
          }
          if (pendingMatch.req.status === 'REJECTED') {
            return res.status(403).json({
              error: `Your registration request was rejected by your supervisor.${pendingMatch.req.rejectionReason ? ` Reason: ${pendingMatch.req.rejectionReason}` : ''}`,
              registrationRejected: true
            });
          }
        }

        return res.status(404).json({
          error: 'No account found with this email address.',
          suggestAlternative: 'phone',
          suggestionMessage: 'If you registered with your mobile number, try logging in using Phone Number OTP.'
        });
      }

      if (user.email.startsWith('temp-') || user.email.includes('@example.com')) {
        return res.status(400).json({
          error: 'No verified email address is associated with this account.',
          suggestAlternative: 'phone',
          suggestionMessage: 'This account was registered using a mobile number. Please switch to Phone OTP to log in.'
        });
      }
    } else {
      const digitsOnly = cleanId.replace(/\D/g, '');
      user = await prisma.user.findFirst({
        where: { mobile: digitsOnly }
      });

      if (!user) {
        const pendingMatch = await findMatchingRegistrationRequest(digitsOnly);
        if (pendingMatch) {
          if (pendingMatch.req.status === 'PENDING' || pendingMatch.req.status === 'ESCALATED') {
            return res.status(403).json({
              error: 'Your registration is currently pending supervisor approval. You will be able to log in once approved.',
              registrationPending: true
            });
          }
          if (pendingMatch.req.status === 'REJECTED') {
            return res.status(403).json({
              error: `Your registration request was rejected by your supervisor.${pendingMatch.req.rejectionReason ? ` Reason: ${pendingMatch.req.rejectionReason}` : ''}`,
              registrationRejected: true
            });
          }
        }

        return res.status(404).json({
          error: 'No account found with this mobile number.',
          suggestAlternative: 'email',
          suggestionMessage: 'If you registered with your email address, try logging in using Email OTP.'
        });
      }
    }

    if (user.status === 'PENDING') {
      return res.status(403).json({
        error: 'Your account is pending supervisor approval.',
        registrationPending: true
      });
    }
    if (user.status === 'REJECTED') {
      return res.status(403).json({ error: `Account has been rejected. Reason: ${user.rejectionReason || 'None'}` });
    }
    if (user.status === 'DEACTIVATED') {
      return res.status(403).json({ error: 'Account is deactivated. Please contact your administrator.' });
    }

    let otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    const targetIdentifier = type === 'email' ? cleanId.toLowerCase() : cleanId.replace(/\D/g, '');

    // For Phone OTP: Dispatch SMS text message via 2Factor TSMS using approved DLT template (MIRTHA)
    if (type === 'phone') {
      const smsResult = await send2FactorSmsOtp(targetIdentifier, otp);
      if (!smsResult.success) {
        return res.status(502).json({
          error: `Failed to deliver SMS text via 2Factor.in: ${smsResult.details || 'Gateway error'}. Please check your phone number and 2Factor account credits.`
        });
      }
    } else if (type === 'email') {
      const emailResult = await sendEmailOtp(targetIdentifier, otp, user?.fullName);
      if (!emailResult.success) {
        return res.status(502).json({
          error: emailResult.error || 'Failed to dispatch email verification OTP.'
        });
      }
    }

    await prisma.otpVerification.deleteMany({
      where: { identifier: targetIdentifier, type: type.toUpperCase() }
    });

    await prisma.otpVerification.create({
      data: {
        identifier: targetIdentifier,
        type: type.toUpperCase(),
        otp,
        expiresAt,
        verified: false,
      }
    });

    console.log(`\n=================================================`);
    console.log(`🔐 [OTP DISPATCH] Method: ${type.toUpperCase()} (SMS TEXT)`);
    console.log(`📱 Recipient: ${targetIdentifier}`);
    console.log(`🔑 Verification Code: ${otp}`);
    console.log(`⏱️  Valid for: 10 minutes`);
    console.log(`=================================================\n`);

    res.json({
      success: true,
      message: type === 'phone'
        ? `OTP has been sent to your registered mobile number as an SMS text message.`
        : `OTP has been sent to your registered email address.`,
      expiresInSeconds: 600
    });
  } catch (error) {
    next(error);
  }
});

const verifyOtpSchema = z.object({
  type: z.enum(['email', 'phone']),
  identifier: z.string().min(1),
  otp: z.string().length(6),
  newPassword: z.string().min(6).optional(),
});

// Verify OTP & Login (with optional password reset)
router.post('/otp/verify', async (req, res, next) => {
  try {
    const { type, identifier, otp, newPassword } = verifyOtpSchema.parse(req.body);
    const targetIdentifier = type === 'email' ? identifier.trim().toLowerCase() : identifier.replace(/\D/g, '');

    const record = await prisma.otpVerification.findFirst({
      where: {
        identifier: targetIdentifier,
        type: type.toUpperCase(),
        verified: false,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!record || record.otp !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please enter the correct code or request a new one.' });
    }

    await prisma.otpVerification.update({
      where: { id: record.id },
      data: { verified: true }
    });

    const user = await prisma.user.findFirst({
      where: type === 'email'
        ? { email: { equals: targetIdentifier, mode: 'insensitive' } }
        : { mobile: targetIdentifier },
      include: {
        role: {
          include: {
            roleModules: {
              include: { module: true }
            }
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (newPassword && newPassword.trim().length >= 6) {
      const passwordHash = await bcrypt.hash(newPassword.trim(), 10);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockoutUntil: null
        }
      });

      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'PASSWORD_RESET_VIA_OTP',
          details: `Password reset via ${type.toUpperCase()} OTP`
        }
      });
    }

    const session = await createSession(user);
    res.json({
      ...session,
      message: newPassword ? 'Password reset successfully and logged in!' : 'Logged in successfully via OTP!'
    });
  } catch (error) {
    next(error);
  }
});

// Refresh Token endpoint
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-key';
    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, refreshSecret);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: {
        user: {
          include: {
            role: {
              include: {
                roleModules: {
                  include: { module: true }
                }
              }
            }
          }
        }
      }
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      if (storedToken) {
        await prisma.refreshToken.delete({ where: { id: storedToken.id } }).catch(() => {});
      }
      return res.status(401).json({ error: 'Refresh token expired or revoked' });
    }

    if (!storedToken.user || storedToken.user.status !== 'APPROVED') {
      return res.status(401).json({ error: 'User is invalid or not approved' });
    }

    // Token rotation: delete used refresh token
    await prisma.refreshToken.delete({ where: { id: storedToken.id } }).catch(() => {});

    // Create a new session
    const session = await createSession(storedToken.user);
    res.json(session);
  } catch (error) {
    next(error);
  }
});

router.post('/logout', authenticate, async (req: any, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({
        where: { token: refreshToken, userId: req.user.id }
      });
    }
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, async (req: any, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        role: {
          include: {
            roleModules: {
              include: { module: true }
            }
          }
        },
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let allowedModules = user.role?.roleModules?.map((rm: any) => rm.module?.slug) || [];
    const roleName = user.role?.name;
    if (roleName === 'Developer' || roleName?.toLowerCase() === 'developer') {
      const allModules = await prisma.module.findMany();
      allowedModules = allModules.map((m: any) => m.slug);
    }



    res.json({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      mobile: user.mobile,
      employeeId: user.employeeId,
      department: user.department,
      role: user.role?.name,
      metadata: user.metadata,
      createdAt: user.createdAt,
      status: user.status,
      allowedModules,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
