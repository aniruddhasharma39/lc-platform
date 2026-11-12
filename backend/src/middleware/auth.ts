import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { isDeveloperUser, verifyGateAccess } from '../lib/railwayHierarchy';

export { isDeveloperUser };

// Ephemeral per-process fallback used ONLY in non-production dev/test runs when env vars are unset.
// Production strictly refuses to sign/verify tokens without JWT_SECRET / JWT_REFRESH_SECRET.
const DEV_EPHEMERAL_JWT_SECRET = crypto.randomBytes(32).toString('hex');
const DEV_EPHEMERAL_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');

export function getJwtSecret(): string {
  const secret = (process.env.JWT_SECRET || '').trim();
  if (secret.length > 0) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET environment variable must be configured in production.');
  }
  return DEV_EPHEMERAL_JWT_SECRET;
}

export function getJwtRefreshSecret(): string {
  const secret = (process.env.JWT_REFRESH_SECRET || '').trim();
  if (secret.length > 0) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_REFRESH_SECRET environment variable must be configured in production.');
  }
  return DEV_EPHEMERAL_REFRESH_SECRET;
}

export interface AuthUser {
  id: number;
  roleId?: number | null;
  role: string;
  allowedModules: string[];
  department?: string | null;
  designation?: string | null;
  zone?: string | null;
  division?: string | null;
  stationId?: number | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export class AuthTokenError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Verify a bearer JWT string and hydrate the active APPROVED user record from Prisma.
 * Shared by HTTP `authenticate` middleware and WebSocket upgrade handlers.
 */
export async function verifyTokenToAuthUser(token: string): Promise<AuthUser> {
  if (!token || !token.trim()) {
    throw new AuthTokenError(401, 'Authentication required');
  }

  let decoded: any;
  try {
    const secret = getJwtSecret();
    decoded = jwt.verify(token.trim(), secret);
  } catch {
    throw new AuthTokenError(401, 'Invalid or expired token');
  }

  const userId = decoded?.userId ?? decoded?.id;
  if (!userId || (typeof userId !== 'number' && typeof userId !== 'string')) {
    throw new AuthTokenError(401, 'Invalid token payload');
  }

  const parsedUserId = typeof userId === 'string' ? parseInt(userId, 10) : userId;
  if (isNaN(parsedUserId)) {
    throw new AuthTokenError(401, 'Invalid user ID in token');
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
      throw new AuthTokenError(401, 'User is invalid or not approved');
    }

    const allowedModules = user.role?.roleModules.map((rm: any) => rm.module.slug) || [];

    return {
      id: user.id,
      roleId: user.roleId ?? null,
      role: user.role?.name || '',
      allowedModules,
      department: user.department,
      designation: user.designation || user.role?.name || '',
      zone: user.zone || '',
      division: user.division || '',
      stationId: user.stationId || null
    };
  } catch (error: any) {
    if (error instanceof AuthTokenError) {
      throw error;
    }
    console.error('Database connection or query error in authenticate middleware:', error);
    if (error?.code === 'P1001' || (error?.message && error.message.includes("Can't reach database server"))) {
      prisma.$disconnect().catch(() => {});
    }
    throw new AuthTokenError(503, 'Authentication service temporarily unavailable, please retry');
  }
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = await verifyTokenToAuthUser(token);
    next();
  } catch (error: any) {
    const status = error instanceof AuthTokenError ? error.status : 401;
    return res.status(status).json({ error: error?.message || 'Authentication failed' });
  }
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!isDeveloperUser(req.user)) {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

export const requireModule = (moduleSlug: string) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (isDeveloperUser(req.user)) {
      return next(); // Developer always has access
    }
    if (!req.user?.allowedModules.includes(moduleSlug)) {
      return res.status(403).json({ error: `Forbidden: Access to ${moduleSlug} is required` });
    }
    next();
  };
};

export const requireAnyModule = (moduleSlugs: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (isDeveloperUser(req.user)) {
      return next();
    }
    const allowed = req.user?.allowedModules || [];
    if (!moduleSlugs.some((slug) => allowed.includes(slug))) {
      return res.status(403).json({ error: `Forbidden: Access to one of [${moduleSlugs.join(', ')}] is required` });
    }
    next();
  };
};

/**
 * Authorize telemetry/manifest webhook callers via constant-time x-ingest-secret header check
 * (IOT_WEBHOOK_SECRET) or authenticated Bearer JWT with `devices` module access.
 */
export const requireDeviceIngestSecret = (req: AuthRequest, res: Response, next: NextFunction) => {
  const configuredSecret = (process.env.IOT_WEBHOOK_SECRET || '').trim();
  const headerVal = req.headers['x-ingest-secret'];
  const providedSecret = Array.isArray(headerVal) ? (headerVal[0] || '') : (headerVal || '');

  if (configuredSecret.length > 0 && providedSecret.length > 0) {
    const expectedBuf = Buffer.from(configuredSecret, 'utf8');
    const actualBuf = Buffer.from(String(providedSecret), 'utf8');
    if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return next();
    }
  }

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return authenticate(req, res, () => {
      requireModule('devices')(req, res, next);
    });
  }

  return res.status(401).json({
    error: 'Unauthorized: Valid x-ingest-secret or authenticated Device Registry token required',
  });
};

/**
 * Verify gate access via jurisdiction rules and respond 403 consistently if denied.
 */
export async function ensureGateAccess(req: AuthRequest, res: Response, gateId: number): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  const authorized = await verifyGateAccess(req.user, gateId, prisma);
  if (!authorized) {
    res.status(403).json({ error: 'Forbidden: You do not have jurisdiction over this LC Gate' });
    return false;
  }
  return true;
}

/**
 * Verify non-Developer creator has division/zone jurisdiction for creating new railway assets.
 */
export async function ensureJurisdictionForAssetCreation(
  req: AuthRequest,
  res: Response,
  target: { zone?: string | null; division?: string | null }
): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (isDeveloperUser(req.user)) {
    return true;
  }
  const dbUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { zone: true, division: true, stationId: true, designation: true, role: { select: { name: true } } },
  });
  const roleStr = (dbUser?.designation || dbUser?.role?.name || req.user.role || '').toLowerCase();
  if (roleStr.includes('gateman') || roleStr.includes('gatesman')) {
    res.status(403).json({ error: 'Forbidden: Gate-level personnel cannot create stations or gates' });
    return false;
  }
  const userDiv = (dbUser?.division || req.user.division || '').trim().toLowerCase();
  const userZone = (dbUser?.zone || req.user.zone || '').trim().toLowerCase();
  const reqDiv = (target.division || '').trim().toLowerCase();
  const reqZone = (target.zone || '').trim().toLowerCase();

  if (userDiv) {
    if (!reqDiv || userDiv !== reqDiv) {
      res.status(403).json({ error: `Forbidden: Jurisdiction restricted to "${dbUser?.division || req.user.division}" division` });
      return false;
    }
    return true;
  }
  if (userZone) {
    if (!reqZone || userZone !== reqZone) {
      res.status(403).json({ error: `Forbidden: Jurisdiction restricted to "${dbUser?.zone || req.user.zone}" zone` });
      return false;
    }
    return true;
  }
  res.status(403).json({ error: 'Forbidden: Account lacks assigned zone/division jurisdiction' });
  return false;
}
