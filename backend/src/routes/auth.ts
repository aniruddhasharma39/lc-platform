import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

const registerSchema = z.object({
  fullName: z.string().min(2),
  mobile: z.string().min(10),
  email: z.string().email(),
  employeeId: z.string().min(2),
  department: z.string().min(2),
  requestedRoleId: z.number().int(),
  password: z.string().min(6),
});

router.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: data.email },
          { mobile: data.mobile },
          { employeeId: data.employeeId },
        ],
      },
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Email, Mobile or Employee ID already in use' });
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const user = await prisma.user.create({
      data: {
        fullName: data.fullName,
        email: data.email,
        mobile: data.mobile,
        employeeId: data.employeeId,
        department: data.department,
        requestedRoleId: data.requestedRoleId,
        passwordHash: hashedPassword,
        status: 'PENDING',
      },
    });

    res.status(201).json({ message: 'Registration successful, pending approval.' });
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
      include: { role: true },
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

    res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role?.name,
        mustChangePassword: user.mustChangePassword,
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
