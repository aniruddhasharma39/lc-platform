import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    role: string;
    allowedModules: string[];
  };
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let decoded: any;
  try {
    const secret = process.env.JWT_SECRET || 'super-secret-jwt-key';
    decoded = jwt.verify(token, secret);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const userId = decoded?.userId ?? decoded?.id;
  if (!userId || (typeof userId !== 'number' && typeof userId !== 'string')) {
    return res.status(401).json({ error: 'Invalid token payload' });
  }

  const parsedUserId = typeof userId === 'string' ? parseInt(userId, 10) : userId;
  if (isNaN(parsedUserId)) {
    return res.status(401).json({ error: 'Invalid user ID in token' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: parsedUserId },
      include: { 
        role: {
          include: {
            roleModules: {
              include: {
                module: true
              }
            }
          }
        } 
      }
    });

    if (!user || user.status !== 'APPROVED') {
      return res.status(401).json({ error: 'User is invalid or not approved' });
    }

    const allowedModules = user.role?.roleModules.map((rm: any) => rm.module.slug) || [];

    req.user = {
      id: user.id,
      role: user.role?.name || '',
      allowedModules
    };
    next();
  } catch (error: any) {
    console.error('Database connection or query error in authenticate middleware:', error);
    if (error?.code === 'P1001' || (error?.message && error.message.includes("Can't reach database server"))) {
      prisma.$disconnect().catch(() => {});
    }
    return res.status(503).json({ error: 'Authentication service temporarily unavailable, please retry' });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'Developer') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

export const requireModule = (moduleSlug: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role === 'Developer') {
      return next(); // Developer always has access
    }
    if (!req.user?.allowedModules.includes(moduleSlug)) {
      return res.status(403).json({ error: `Forbidden: Access to ${moduleSlug} is required` });
    }
    next();
  };
};
