import { PrismaClient } from '@prisma/client';

export type DepartmentType = 'Operations' | 'Engineering';
export type DesignationLevel = 'DIVISIONAL' | 'STATION' | 'GATE';

export interface DesignationConfig {
  name: string;
  department: DepartmentType;
  seniority: number; // 1 = highest rank in department
  level: DesignationLevel;
  maxGates?: number; // Exactly 1 for Gateman
  immediateSuperior: string | null; // null for Senior DOM / Senior DEN (governance approval)
  description: string;
  defaultRoleName: string;
  defaultModuleSlugs: string[];
}

export const DEPARTMENTS: DepartmentType[] = ['Operations', 'Engineering'];

export const DESIGNATIONS: Record<string, DesignationConfig> = {
  // ==========================================
  // OPERATIONS DEPARTMENT
  // Senior DOM -> DOM -> ADOM/AOM -> Station Master
  // ==========================================
  'Senior DOM': {
    name: 'Senior DOM',
    department: 'Operations',
    seniority: 1,
    level: 'DIVISIONAL',
    immediateSuperior: null,
    description: 'Senior Divisional Operations Manager (Divisional-level officer)',
    defaultRoleName: 'Senior DOM',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'devices', 'manage-users']
  },
  'DOM': {
    name: 'DOM',
    department: 'Operations',
    seniority: 2,
    level: 'DIVISIONAL',
    immediateSuperior: 'Senior DOM',
    description: 'Divisional Operations Manager (Divisional-level officer)',
    defaultRoleName: 'DOM',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'devices', 'manage-users']
  },
  'ADOM/AOM': {
    name: 'ADOM/AOM',
    department: 'Operations',
    seniority: 3,
    level: 'DIVISIONAL',
    immediateSuperior: 'DOM',
    description: 'Assistant Divisional Operations Manager / AOM (Divisional-level officer)',
    defaultRoleName: 'ADOM/AOM',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'devices', 'manage-users']
  },
  'Station Master': {
    name: 'Station Master',
    department: 'Operations',
    seniority: 4,
    level: 'STATION',
    immediateSuperior: 'ADOM/AOM',
    description: 'Station Master (Station-level officer responsible for station LC gates)',
    defaultRoleName: 'Station Master',
    defaultModuleSlugs: ['lc-gates', 'reports']
  },

  // ==========================================
  // ENGINEERING DEPARTMENT
  // Senior DEN -> DEN -> ADEN -> Engineering Supervisor -> Gateman
  // ==========================================
  'Senior DEN': {
    name: 'Senior DEN',
    department: 'Engineering',
    seniority: 1,
    level: 'DIVISIONAL',
    immediateSuperior: null,
    description: 'Senior Divisional Engineer (Divisional-level officer)',
    defaultRoleName: 'Senior DEN',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'devices', 'manage-users']
  },
  'DEN': {
    name: 'DEN',
    department: 'Engineering',
    seniority: 2,
    level: 'DIVISIONAL',
    immediateSuperior: 'Senior DEN',
    description: 'Divisional Engineer (Divisional-level officer)',
    defaultRoleName: 'DEN',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'devices', 'manage-users']
  },
  'ADEN': {
    name: 'ADEN',
    department: 'Engineering',
    seniority: 3,
    level: 'DIVISIONAL',
    immediateSuperior: 'DEN',
    description: 'Assistant Divisional Engineer (Divisional-level officer)',
    defaultRoleName: 'ADEN',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'devices', 'manage-users']
  },
  'Engineering Supervisor': {
    name: 'Engineering Supervisor',
    department: 'Engineering',
    seniority: 4,
    level: 'STATION',
    immediateSuperior: 'ADEN',
    description: 'Engineering Supervisor (Station/Gate supervisory role)',
    defaultRoleName: 'Engineering Supervisor',
    defaultModuleSlugs: ['lc-gates', 'reports', 'manage-users', 'devices']
  },
  'Gateman': {
    name: 'Gateman',
    department: 'Engineering',
    seniority: 5,
    level: 'GATE',
    maxGates: 1,
    immediateSuperior: 'Engineering Supervisor',
    description: 'Gateman (Individual LC Gate-level role, strictly 1 gate)',
    defaultRoleName: 'Gateman',
    defaultModuleSlugs: ['lc-gates']
  }
};

/**
 * Returns designations available for a given department
 */
export function getDesignationsForDepartment(dept: DepartmentType): DesignationConfig[] {
  return Object.values(DESIGNATIONS)
    .filter(d => d.department === dept)
    .sort((a, b) => a.seniority - b.seniority);
}

/**
 * Get config for a designation name (normalizing case/punctuation)
 */
export function getDesignationConfig(name?: string | null): DesignationConfig | null {
  if (!name) return null;
  const direct = DESIGNATIONS[name];
  if (direct) return direct;

  const clean = name.trim().toLowerCase();
  for (const [key, cfg] of Object.entries(DESIGNATIONS)) {
    if (key.toLowerCase() === clean) return cfg;
    if (clean === 'adom' || clean === 'aom' || clean === 'adom/aom') {
      if (key === 'ADOM/AOM') return cfg;
    }
    if (clean === 'supervisor' || clean === 'engineering supervisor') {
      if (key === 'Engineering Supervisor') return cfg;
    }
    if (clean === 'gatesman' || clean === 'gateman') {
      if (key === 'Gateman') return cfg;
    }
  }
  return null;
}

/**
 * Checks whether an authenticated user is authorized to approve/reject a registration request
 * based strictly on:
 * 1. Immediate superior designation hierarchy
 * 2. Geographical jurisdiction (Zone, Division, Station, and Gate assignment)
 */
export function canApproveRequest(approver: any, request: any, approverGateIds: number[] = []): {
  allowed: boolean;
  reason?: string;
  isGovernanceIntervention?: boolean;
} {
  // System administrators / Developers retain governance-level authority
  const isDeveloper = approver.role?.name === 'Developer' || approver.roleId === 1;

  const targetCfg = getDesignationConfig(request.designation);
  if (!targetCfg) {
    if (isDeveloper) return { allowed: true, isGovernanceIntervention: true };
    return { allowed: false, reason: 'Unknown or unconfigured requested designation.' };
  }

  // Top-level officers (Senior DOM and Senior DEN) have no immediate superior within department
  // They require System Admin / Governance approval
  if (!targetCfg.immediateSuperior) {
    if (isDeveloper) {
      return { allowed: true, isGovernanceIntervention: true };
    }
    return { allowed: false, reason: 'Senior departmental officer registration requires governance-level approval.' };
  }

  // Normal hierarchical check: Approver designation must match immediate superior
  const approverCfg = getDesignationConfig(approver.designation);
  
  if (isDeveloper) {
    // Developer can approve as a governance intervention (e.g. when immediate superior is not yet registered)
    return { allowed: true, isGovernanceIntervention: true };
  }

  if (!approverCfg || approverCfg.name !== targetCfg.immediateSuperior) {
    return {
      allowed: false,
      reason: `Only an official holding designation "${targetCfg.immediateSuperior}" can review requests for "${targetCfg.name}".`
    };
  }

  // Geographical jurisdiction validation
  if (request.zone && approver.zone && request.zone.toLowerCase() !== approver.zone.toLowerCase()) {
    return {
      allowed: false,
      reason: `Approver zone (${approver.zone}) does not match applicant zone (${request.zone}).`
    };
  }

  if (request.division && approver.division && request.division.toLowerCase() !== approver.division.toLowerCase()) {
    return {
      allowed: false,
      reason: `Approver division (${approver.division}) does not match applicant division (${request.division}).`
    };
  }

  // If approver is an Engineering Supervisor approving a Gateman:
  // Must be in the same station or responsible for the Gateman's requested gate!
  if (approverCfg.name === 'Engineering Supervisor' && targetCfg.name === 'Gateman') {
    if (approver.stationId && request.stationId && approver.stationId !== request.stationId) {
      return {
        allowed: false,
        reason: 'Engineering Supervisor can only review Gatemen assigned to their own station.'
      };
    }
    const reqGateIds: number[] = Array.isArray(request.gateIds) ? request.gateIds : [];
    if (approverGateIds.length > 0 && reqGateIds.length > 0) {
      const hasOverlap = reqGateIds.some(gid => approverGateIds.includes(gid));
      if (!hasOverlap) {
        return {
          allowed: false,
          reason: 'Engineering Supervisor can only review Gatemen for level crossings explicitly under their supervision.'
        };
      }
    }
  }

  return { allowed: true, isGovernanceIntervention: false };
}

/**
 * Build Prisma where clause for filtering gates accessible to a user
 */
export async function buildUserGateWhereClause(user: any, prisma: PrismaClient): Promise<any> {
  const isDeveloper = user.role?.name === 'Developer' || user.roleId === 1;
  if (isDeveloper) return {};

  const userGates = await prisma.userGate.findMany({
    where: { userId: user.id },
    select: { gateId: true }
  });
  const assignedGateIds = userGates.map(ug => ug.gateId);

  const desig = getDesignationConfig(user.designation);

  // 1. Gate-level role (Gateman): STRICTLY their assigned gate(s)
  if (desig?.level === 'GATE') {
    if (assignedGateIds.length === 0) return { id: -1 }; // No access until assigned
    return { id: { in: assignedGateIds } };
  }

  // 2. Station-level role (Station Master, Engineering Supervisor):
  if (desig?.level === 'STATION') {
    if (assignedGateIds.length > 0) {
      return { id: { in: assignedGateIds } };
    }
    if (user.stationId) {
      return { stationId: user.stationId };
    }
    return { id: -1 };
  }

  // 3. Divisional officers (Senior DOM, DOM, ADOM, Senior DEN, DEN, ADEN):
  if (desig?.level === 'DIVISIONAL') {
    if (user.division) {
      return { division: { equals: user.division, mode: 'insensitive' } };
    }
    if (user.zone) {
      return { zone: { equals: user.zone, mode: 'insensitive' } };
    }
    return { id: -1 };
  }

  // Fallback for generic legacy roles:
  if (assignedGateIds.length > 0) {
    return { id: { in: assignedGateIds } };
  }
  if (user.stationId) {
    return { stationId: user.stationId };
  }
  if (user.division) {
    return { division: { equals: user.division, mode: 'insensitive' } };
  }
  if (user.zone) {
    return { zone: { equals: user.zone, mode: 'insensitive' } };
  }

  return { id: -1 };
}

/**
 * Verify whether a user can access a specific gate by ID.
 * Throws 403 error or returns boolean.
 */
export async function verifyGateAccess(user: any, gateId: number, prisma: PrismaClient): Promise<boolean> {
  const isDeveloper = user.role?.name === 'Developer' || user.roleId === 1;
  if (isDeveloper) return true;

  const whereClause = await buildUserGateWhereClause(user, prisma);
  const gate = await prisma.lCGate.findFirst({
    where: {
      AND: [
        { id: gateId },
        whereClause
      ]
    },
    select: { id: true }
  });

  return gate !== null;
}

/**
 * Seeds and synchronizes all designation roles and their module permissions in the database
 */
export async function ensureDesignationRoles(prisma: PrismaClient) {
  const modules = await prisma.module.findMany();
  const moduleMap = new Map(modules.map(m => [m.slug, m.id]));

  for (const [desigName, cfg] of Object.entries(DESIGNATIONS)) {
    const role = await prisma.role.upsert({
      where: { name: cfg.defaultRoleName },
      update: {},
      create: { name: cfg.defaultRoleName }
    });

    for (const slug of cfg.defaultModuleSlugs) {
      const modId = moduleMap.get(slug);
      if (modId) {
        await prisma.roleModule.upsert({
          where: {
            roleId_moduleId: {
              roleId: role.id,
              moduleId: modId
            }
          },
          update: {},
          create: {
            roleId: role.id,
            moduleId: modId
          }
        });
      }
    }
  }
}
