import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dixdw1mus',
  api_key: process.env.CLOUDINARY_API_KEY || '647788876868715',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'Aku2U6rp22oHgQQEESnZ7w3YaUI'
});

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

router.post('/register', upload.any(), async (req, res, next) => {
  try {
    let parsedData: any;
    let requestedRoleId: number;
    let formId: number;

    // Support both application/json and multipart/form-data
    if (req.is('multipart/form-data')) {
      parsedData = JSON.parse(req.body.data);
      requestedRoleId = req.body.roleId ? parseInt(req.body.roleId) : -1;
      formId = parseInt(req.body.formId);
    } else {
      parsedData = req.body.data;
      requestedRoleId = req.body.requestedRoleId || -1;
      formId = req.body.formId;
    }

    if (!formId) return res.status(400).json({ error: 'Missing formId' });

    // Verify form is LIVE
    const form = await prisma.registrationForm.findUnique({ where: { id: formId } });
    if (!form || form.status !== 'LIVE') {
      return res.status(400).json({ error: 'Invalid or inactive registration form' });
    }

    // Upload files to Cloudinary
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files) {
        const fileUrl = await new Promise<string>((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'lc-platform-registration' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result!.secure_url);
            }
          );
          stream.end(file.buffer);
        });
        parsedData[file.fieldname] = fileUrl; // Add URL to the JSON payload mapped by fieldName
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
    const form = await prisma.registrationForm.findFirst({
      where: { status: 'LIVE' }
    });
    
    if (!form) {
      return res.status(404).json({ error: 'No active registration form available.' });
    }
    
    const roles = await prisma.role.findMany({
      where: { name: { not: 'Developer' } } // Don't allow registering as Developer
    });
    
    res.json({ form, roles });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: data.identifier },
          { mobile: data.identifier },
          { employeeId: data.identifier },
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
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status === 'PENDING') {
      return res.status(403).json({ error: 'Account pending approval' });
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

    const secret = process.env.JWT_SECRET || 'super-secret-jwt-key';
    const refreshSecret = process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-key';
    
    const token = jwt.sign({ userId: user.id }, secret, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ userId: user.id }, refreshSecret, { expiresIn: '7d' });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt,
      },
    });

    let allowedModules = user.role?.roleModules.map((rm: any) => rm.module.slug) || [];
    if (user.role?.name === 'Developer') {
      const allModules = await prisma.module.findMany();
      allowedModules = allModules.map(m => m.slug);
    }

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role?.name,
        mustChangePassword: user.mustChangePassword,
        allowedModules
      }
    });
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

export default router;
