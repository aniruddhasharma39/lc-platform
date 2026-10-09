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

  try {
    const secret = process.env.JWT_SECRET || 'super-secret-jwt-key';
    const decoded = jwt.verify(token, secret) as { userId: number };
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
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
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
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
