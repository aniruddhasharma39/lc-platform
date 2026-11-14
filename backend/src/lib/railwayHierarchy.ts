import { PrismaClient } from '@prisma/client';

export type DepartmentType = 'Operations' | 'Engineering';
export type DesignationLevel = 'DIVISIONAL' | 'SECTION' | 'STATION' | 'GATE';

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

/**
 * Canonical Developer & Administrator governance check across all backend routes and authorization helpers.
 * Grants top-level governance authority to Developer, Admin, and Administrator accounts.
 */
export function isDeveloperUser(user: any): boolean {
  if (!user) return false;
  const roleName =
    typeof user.role === 'string'
      ? user.role
      : user.role?.name || '';
  const designation = user.designation || '';
  const r = roleName.trim().toLowerCase();
  const d = designation.trim().toLowerCase();
  return (
    r === 'developer' ||
    r === 'admin' ||
    r === 'administrator' ||
    r === 'system admin' ||
    d === 'developer' ||
    d === 'admin' ||
    d === 'administrator' ||
    d === 'system admin'
  );
}

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
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'manage-users']
  },
  'DOM': {
    name: 'DOM',
    department: 'Operations',
    seniority: 2,
    level: 'DIVISIONAL',
    immediateSuperior: 'Senior DOM',
    description: 'Divisional Operations Manager (Divisional-level officer)',
    defaultRoleName: 'DOM',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'manage-users']
  },
  'ADOM/AOM': {
    name: 'ADOM/AOM',
    department: 'Operations',
    seniority: 3,
    level: 'DIVISIONAL',
    immediateSuperior: 'DOM',
    description: 'Assistant Divisional Operations Manager / AOM (Divisional-level officer)',
    defaultRoleName: 'ADOM/AOM',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'manage-users']
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
  // Senior DEN (1) -> DEN (2) -> ADEN (3) -> CPWI (4) -> PWI (5) -> Restkeeper (6) -> Gateman (7)
  // ==========================================
  'Senior DEN': {
    name: 'Senior DEN',
    department: 'Engineering',
    seniority: 1,
    level: 'DIVISIONAL',
    immediateSuperior: null,
    description: 'Senior Divisional Engineer (Divisional-level Department Admin)',
    defaultRoleName: 'Senior DEN',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'manage-users']
  },
  'DEN': {
    name: 'DEN',
    department: 'Engineering',
    seniority: 2,
    level: 'DIVISIONAL',
    immediateSuperior: 'Senior DEN',
    description: 'Divisional Engineer (Divisional-level officer)',
    defaultRoleName: 'DEN',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'manage-users']
  },
  'ADEN': {
    name: 'ADEN',
    department: 'Engineering',
    seniority: 3,
    level: 'DIVISIONAL',
    immediateSuperior: 'DEN',
    description: 'Assistant Divisional Engineer (Sub-Divisional officer)',
    defaultRoleName: 'ADEN',
    defaultModuleSlugs: ['lc-gates', 'reports', 'cluster', 'manage-users']
  },
  'CPWI': {
    name: 'CPWI',
    department: 'Engineering',
    seniority: 4,
    level: 'SECTION',
    immediateSuperior: 'ADEN',
    description: 'Chief Permanent Way Inspector / SSE P-Way (Senior section in-charge)',
    defaultRoleName: 'CPWI',
    defaultModuleSlugs: ['lc-gates', 'reports', 'manage-users', 'cluster']
  },
  'PWI': {
    name: 'PWI',
    department: 'Engineering',
    seniority: 5,
    level: 'SECTION',
    immediateSuperior: 'CPWI',
    description: 'Permanent Way Inspector / JE P-Way (Section field in-charge)',
    defaultRoleName: 'PWI',
    defaultModuleSlugs: ['lc-gates', 'reports', 'manage-users']
  },
  'Restkeeper': {
    name: 'Restkeeper',
    department: 'Engineering',
    seniority: 6,
    level: 'STATION',
    immediateSuperior: 'PWI',
    description: 'Restkeeper (Station gate rounds, shift roster & relief in-charge)',
    defaultRoleName: 'Restkeeper',
    defaultModuleSlugs: ['lc-gates', 'reports']
  },
  'Gateman': {
    name: 'Gateman',
    department: 'Engineering',
    seniority: 7,
    level: 'GATE',
    maxGates: 1,
    immediateSuperior: 'PWI',
    description: 'Gateman (Individual LC Gate-level role, strictly 1 gate)',
    defaultRoleName: 'Gateman',
    defaultModuleSlugs: ['lc-gates', 'reports']
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
    if (clean === 'cpwi' || clean === 'chief permanent way inspector' || clean === 'sse/p-way' || clean === 'sse p-way' || clean === 'chief p-way inspector') {
      if (key === 'CPWI') return cfg;
    }
    if (clean === 'pwi' || clean === 'permanent way inspector' || clean === 'je/p-way' || clean === 'je p-way' || clean === 'engineering supervisor' || clean === 'supervisor') {
      if (key === 'PWI') return cfg;
    }
    if (clean === 'restkeeper' || clean === 'rest keeper') {
      if (key === 'Restkeeper') return cfg;
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
  const isDeveloper = isDeveloperUser(approver);

  // Extract target fields safely from request or request.data
  let targetDesignation = request.designation;
  let targetDepartment = request.department;
  let targetZone = request.zone;
  let targetDivision = request.division;
  let targetStationId = request.stationId;
  let targetGateIds = request.gateIds;

  if (!targetDesignation && request.data) {
    try {
      const parsed = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
      targetDesignation = parsed.designation || parsed.role || parsed.roleName;
      targetDepartment = parsed.department || targetDepartment;
      targetZone = parsed.zone || targetZone;
      targetDivision = parsed.division || targetDivision;
      targetStationId = parsed.stationId !== undefined ? parsed.stationId : targetStationId;
      targetGateIds = parsed.gateIds || targetGateIds;
    } catch {}
  }

  const targetCfg = getDesignationConfig(targetDesignation);
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
  const approverDesigName = approver.designation || (typeof approver.role === 'string' ? approver.role : approver.role?.name);
  const approverCfg = getDesignationConfig(approverDesigName);
  
  if (isDeveloper) {
    // Developer can approve as a governance intervention (e.g. when immediate superior is not yet registered)
    return { allowed: true, isGovernanceIntervention: true };
  }

  const isAuthorizedSuperior =
    approverCfg &&
    (approverCfg.name === targetCfg.immediateSuperior ||
      (targetCfg.name === 'Gateman' && (approverCfg.name === 'PWI' || approverCfg.name === 'Restkeeper')));

  if (!isAuthorizedSuperior) {
    return {
      allowed: false,
      reason: `Only an official holding designation "${targetCfg.immediateSuperior}" can review requests for "${targetCfg.name}".`
    };
  }

  // Department must match
  if (approverCfg.department !== targetCfg.department) {
    return {
      allowed: false,
      reason: `Approver department (${approverCfg.department}) does not match applicant department (${targetCfg.department}).`
    };
  }

  // Geographical jurisdiction validation
  if (targetZone && approver.zone && targetZone.toLowerCase() !== approver.zone.toLowerCase()) {
    return {
      allowed: false,
      reason: `Approver zone (${approver.zone}) does not match applicant zone (${targetZone}).`
    };
  }

  if (targetDivision && approver.division && targetDivision.toLowerCase() !== approver.division.toLowerCase()) {
    return {
      allowed: false,
      reason: `Approver division (${approver.division}) does not match applicant division (${targetDivision}).`
    };
  }

  // If approver is an Engineering Supervisor approving a Gateman:
  // Must be in the same station or responsible for the Gateman's requested gate!
  if (approverCfg.name === 'Engineering Supervisor' && targetCfg.name === 'Gateman') {
    if (approver.stationId && targetStationId && approver.stationId !== targetStationId) {
      return {
        allowed: false,
        reason: 'Engineering Supervisor can only review Gatemen assigned to their own station.'
      };
    }
    const reqGateIds: number[] = Array.isArray(targetGateIds) ? targetGateIds : [];
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
 * Validates whether an approver has the hierarchical authority to assign a given role to an applicant upon approval.
 *
 * Rules:
 * 1. Developer role can ONLY be assigned if approver is an existing Developer. Non-developers are strictly forbidden.
 * 2. Developer has full governance authority to assign any role.
 * 3. Non-developers can NEVER assign upper-body roles (roles with seniority <= approver's seniority).
 *    An approver can ONLY assign roles strictly subordinate to them (targetSeniority > approverSeniority).
 * 4. Non-developers can only assign roles within their own department.
 */
export function canAssignRole(
  approver: any,
  targetRoleId: number,
  targetRoleName?: string
): { allowed: boolean; reason?: string } {
  const isDeveloper = isDeveloperUser(approver);

  const roleName = targetRoleName || '';
  const isTargetDeveloper = targetRoleName ? roleName.trim().toLowerCase() === 'developer' : targetRoleId === 1;

  // Rule 1: Developer role can ONLY be assigned by Developer
  if (isTargetDeveloper) {
    if (!isDeveloper) {
      return {
        allowed: false,
        reason: 'Security violation: Only an existing Developer can grant the Developer role.'
      };
    }
    return { allowed: true };
  }

  // Developer has full governance authority
  if (isDeveloper) {
    return { allowed: true };
  }

  // Umbrella roles like Zone Officer and Division Officer cannot be assigned by station/supervisory officers
  if (roleName === 'Zone Officer' || roleName === 'Division Officer') {
    return {
      allowed: false,
      reason: 'Zone and Division administrative roles require governance-level approval.'
    };
  }

  // Identify approver's designation and seniority
  const approverDesigName = approver.designation || (typeof approver.role === 'string' ? approver.role : approver.role?.name);
  const approverCfg = getDesignationConfig(approverDesigName);

  if (!approverCfg) {
    return {
      allowed: false,
      reason: 'Your account does not have a recognized railway designation to assign roles.'
    };
  }

  // Find target designation config matching the target role
  const targetCfg = getDesignationConfig(roleName) || 
    Object.values(DESIGNATIONS).find(d => d.defaultRoleName.toLowerCase() === roleName.toLowerCase());

  if (!targetCfg) {
    return {
      allowed: false,
      reason: `Unknown or unconfigured role "${roleName}".`
    };
  }

  // Department check: Approver cannot assign roles in another department
  if (approverCfg.department !== targetCfg.department) {
    return {
      allowed: false,
      reason: `Department violation: You belong to ${approverCfg.department} and cannot assign roles in ${targetCfg.department}.`
    };
  }

  // Seniority check: Subordinate only! (target.seniority must be strictly GREATER than approver.seniority)
  if (targetCfg.seniority <= approverCfg.seniority) {
    return {
      allowed: false,
      reason: `Hierarchy violation: You (${approverCfg.name}) cannot assign an upper-level or peer role (${targetCfg.name}). You may only assign subordinate roles.`
    };
  }

  return { allowed: true };
}

/**
 * Returns the list of role names that the given approver is hierarchically authorized to assign.
 */
export function getAllowedRoleNamesForApprover(approver: any): string[] {
  const isDeveloper = isDeveloperUser(approver);
  if (isDeveloper) {
    return ['Developer', 'Zone Officer', 'Division Officer', ...Object.keys(DESIGNATIONS)];
  }

  const approverDesigName = approver.designation || (typeof approver.role === 'string' ? approver.role : approver.role?.name);
  const approverCfg = getDesignationConfig(approverDesigName);
  if (!approverCfg) return [];

  return Object.values(DESIGNATIONS)
    .filter(d => d.department === approverCfg.department && d.seniority > approverCfg.seniority)
    .map(d => d.defaultRoleName);
}

/**
 * Build Prisma where clause for filtering existing users visible to a viewer in User Management.
 * Enforces strict downward role hierarchy:
 * 1. Developer sees all users.
 * 2. Departmental isolation: Operations only sees Operations, Engineering only sees Engineering.
 * 3. Strict downward seniority: viewer only sees subordinates strictly below them in seniority (target.seniority > viewer.seniority).
 * 4. Geographical jurisdiction:
 *    - Divisional officers see subordinates in their own zone & division.
 *    - Station officers see subordinates in their own station or supervised gates.
 *    - Gate level staff (Gateman) sees NO users.
 */
export async function buildUserManagementWhereClause(viewer: any, prisma: PrismaClient): Promise<any> {
  const isDeveloper = isDeveloperUser(viewer);
  if (isDeveloper) return {};

  let effectiveViewer = viewer;
  if (viewer.id && (viewer.division === undefined || viewer.designation === undefined)) {
    const fetched = await prisma.user.findUnique({
      where: { id: viewer.id },
      select: { id: true, department: true, designation: true, zone: true, division: true, stationId: true, role: { select: { name: true } } }
    });
    if (fetched) {
      effectiveViewer = { ...viewer, ...fetched };
    }
  }

  const viewerDesigName = effectiveViewer.designation || (typeof effectiveViewer.role === 'string' ? effectiveViewer.role : effectiveViewer.role?.name);
  const viewerCfg = getDesignationConfig(viewerDesigName);

  // If no designation or not recognized in railway hierarchy, cannot manage any users
  if (!viewerCfg) {
    return { id: -1 };
  }

  // Gate-level role (e.g. Gateman): lowest level, sees NO users
  if (viewerCfg.level === 'GATE') {
    return { id: -1 };
  }

  // Find all subordinate designations in the SAME department with strictly lower rank (seniority > viewerCfg.seniority)
  const subordinateConfigs = Object.values(DESIGNATIONS).filter(
    d => d.department === viewerCfg.department && d.seniority > viewerCfg.seniority
  );

  if (subordinateConfigs.length === 0) {
    return { id: -1 };
  }

  const subordinateNames = subordinateConfigs.map(d => d.name);

  // Exclude self, exclude Developer, restrict to viewer's department, and restrict to subordinate designations
  const baseConditions: any[] = [
    { id: { not: effectiveViewer.id } },
    { role: { name: { not: 'Developer' } } },
    { department: { equals: viewerCfg.department, mode: 'insensitive' } },
    {
      OR: [
        { designation: { in: subordinateNames } },
        { role: { name: { in: subordinateNames } } }
      ]
    }
  ];

  // Geographical jurisdiction filtering
  if (viewerCfg.level === 'DIVISIONAL' || viewerCfg.level === 'SECTION') {
    const viewerDivision = effectiveViewer.division || effectiveViewer.station?.division;
    const viewerZone = effectiveViewer.zone || effectiveViewer.station?.zone;

    if (viewerDivision) {
      baseConditions.push({
        OR: [
          { division: { equals: viewerDivision, mode: 'insensitive' } },
          { station: { division: { equals: viewerDivision, mode: 'insensitive' } } }
        ]
      });
    }
    if (viewerZone) {
      baseConditions.push({
        OR: [
          { zone: { equals: viewerZone, mode: 'insensitive' } },
          { station: { zone: { equals: viewerZone, mode: 'insensitive' } } }
        ]
      });
    }
  } else if (viewerCfg.level === 'STATION') {
    // Station/Section supervisor: can only see subordinates assigned to their station or supervised gates
    const viewerGates = await prisma.userGate.findMany({
      where: { userId: effectiveViewer.id },
      select: { gateId: true }
    });
    const viewerGateIds = viewerGates.map(ug => ug.gateId);

    const stationConditions: any[] = [];
    if (effectiveViewer.stationId) {
      stationConditions.push({ stationId: effectiveViewer.stationId });
    }
    if (viewerGateIds.length > 0) {
      stationConditions.push({
        assignedGates: {
          some: {
            gateId: { in: viewerGateIds }
          }
        }
      });
    }

    if (stationConditions.length > 0) {
      baseConditions.push({ OR: stationConditions });
    } else {
      return { id: -1 };
    }
  }

  return { AND: baseConditions };
}

/**
 * Verify whether an authenticated viewer has authority to manage (deactivate, reactivate, change role, delete) a target user.
 */
export async function verifyUserManagementAccess(viewer: any, targetUserId: number, prisma: PrismaClient): Promise<{ allowed: boolean; reason?: string }> {
  const isDeveloper = isDeveloperUser(viewer);
  if (isDeveloper) return { allowed: true };

  if (viewer.id === targetUserId) {
    return { allowed: false, reason: 'You cannot perform administrative management actions on your own account.' };
  }

  const whereClause = await buildUserManagementWhereClause(viewer, prisma);
  const targetUser = await prisma.user.findFirst({
    where: {
      AND: [
        { id: targetUserId },
        whereClause
      ]
    },
    select: { id: true, fullName: true, designation: true }
  });

  if (!targetUser) {
    return {
      allowed: false,
      reason: 'Forbidden: You do not have hierarchical authority to manage this user.'
    };
  }

  return { allowed: true };
}

export async function buildUserGateWhereClause(user: any, prisma: PrismaClient): Promise<any> {
  const isDeveloper = isDeveloperUser(user);
  if (isDeveloper) return {};

  let effectiveUser = user;
  if (user.id && (user.division === undefined || user.designation === undefined)) {
    const fetched = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, designation: true, zone: true, division: true, stationId: true, role: { select: { name: true } } }
    });
    if (fetched) {
      effectiveUser = { ...user, ...fetched };
    }
  }

  const userGates = await prisma.userGate.findMany({
    where: { userId: user.id },
    select: { gateId: true }
  });
  const assignedGateIds = userGates.map(ug => ug.gateId);

  const desig = getDesignationConfig(effectiveUser.designation) || getDesignationConfig(effectiveUser.role?.name || effectiveUser.role);

  // 1. Gate-level role (Gateman): STRICTLY their assigned gate(s)
  if (desig?.level === 'GATE') {
    if (assignedGateIds.length === 0) return { id: -1 }; // No access until assigned
    return { id: { in: assignedGateIds } };
  }

  // 2. Station-level role (Station Master, Engineering Supervisor):
  if (desig?.level === 'STATION') {
    if (assignedGateIds.length > 0) {
      return effectiveUser.stationId
        ? { OR: [{ id: { in: assignedGateIds } }, { stationId: effectiveUser.stationId }] }
        : { id: { in: assignedGateIds } };
    }
    if (effectiveUser.stationId) {
      return { stationId: effectiveUser.stationId };
    }
    return { id: -1 };
  }

  // 3. Section supervisors (PWI, CPWI) & Divisional officers (Senior DOM, DOM, ADOM, Senior DEN, DEN, ADEN):
  if (desig?.level === 'SECTION' || desig?.level === 'DIVISIONAL') {
    const userDivision = effectiveUser.division || effectiveUser.station?.division;
    const userZone = effectiveUser.zone || effectiveUser.station?.zone;
    if (userDivision) {
      return {
        OR: [
          { division: { equals: userDivision, mode: 'insensitive' } },
          { station: { division: { equals: userDivision, mode: 'insensitive' } } }
        ]
      };
    }
    if (userZone) {
      return {
        OR: [
          { zone: { equals: userZone, mode: 'insensitive' } },
          { station: { zone: { equals: userZone, mode: 'insensitive' } } }
        ]
      };
    }
    return { id: -1 };
  }

  // Fallback for generic legacy roles:
  if (assignedGateIds.length > 0) {
    return { id: { in: assignedGateIds } };
  }
  if (effectiveUser.stationId) {
    return { stationId: effectiveUser.stationId };
  }
  if (effectiveUser.division) {
    return { division: { equals: effectiveUser.division, mode: 'insensitive' } };
  }
  if (effectiveUser.zone) {
    return { zone: { equals: effectiveUser.zone, mode: 'insensitive' } };
  }

  return { id: -1 };
}

/**
 * Verify whether a user can access a specific gate by ID.
 * Throws 403 error or returns boolean.
 */
export async function verifyGateAccess(user: any, gateId: number, prisma: PrismaClient): Promise<boolean> {
  if (!user) return false;
  const isDeveloper = isDeveloperUser(user);
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
 * Normalizes jurisdiction strings (divisions, zones) for robust comparison.
 * Trims whitespace, lowercases, and strips common suffixes like 'Division', 'Railway', 'Zone'.
 */
export function normalizeJurisdictionString(str?: string | null): string {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/\s+(division|div|railway|zone)$/i, '')
    .trim();
}

export interface GateAlertRecipients {
  gate: {
    id: number;
    lcNumber: string;
    name: string | null;
    locationName?: string | null;
    division: string | null;
    zone: string | null;
    stationId: number | null;
    stationName?: string | null;
  };
  smsRecipients: Array<{
    userId: number;
    fullName: string;
    phone: string;
    designation: string | null;
    department: string | null;
    reason: string;
  }>;
  emailRecipients: Array<{
    userId: number;
    fullName: string;
    email: string;
    designation: string | null;
    department: string | null;
    reason: string;
  }>;
  matchedUsers: any[];
}

function doesUserMatchGateJurisdiction(
  u: any,
  gate: { id: number; stationId?: number | null; division?: string | null; zone?: string | null },
  assignedGateIds: number[]
): string | null {
  if (isDeveloperUser(u)) {
    return 'Developer / System Governance Override';
  }

  const cfg = getDesignationConfig(u.designation) || getDesignationConfig(u.role?.name || u.role);
  const level = cfg?.level;
  const normGateDivision = normalizeJurisdictionString(gate.division);
  const normGateZone = normalizeJurisdictionString(gate.zone);

  // Gate-level role (Gateman): STRICTLY assigned gates
  if (level === 'GATE') {
    return assignedGateIds.includes(gate.id) ? 'Directly Assigned Gate (Gateman)' : null;
  }

  // Station-level role (Station Master, Engineering Supervisor)
  if (level === 'STATION') {
    if (assignedGateIds.includes(gate.id)) return 'Assigned Gate (Station Level)';
    if (u.stationId && gate.stationId && u.stationId === gate.stationId) return 'Station Jurisdiction Match';
    return null;
  }

  // Divisional-level officers (Senior DOM, DOM, ADOM, Senior DEN, DEN, ADEN)
  if (level === 'DIVISIONAL') {
    if (u.division && normGateDivision && normalizeJurisdictionString(u.division) === normGateDivision) {
      return 'Divisional Jurisdiction Match';
    }
    return null;
  }

  // Fallback for legacy roles without designation config
  if (assignedGateIds.includes(gate.id)) return 'Explicit Gate Assignment';
  if (u.stationId && gate.stationId && u.stationId === gate.stationId) return 'Station Fallback Match';
  if (u.division && normGateDivision && normalizeJurisdictionString(u.division) === normGateDivision) return 'Division Fallback Match';
  if (u.zone && normGateZone && normalizeJurisdictionString(u.zone) === normGateZone) return 'Zonal Jurisdiction Match';
  return null;
}

/**
 * Resolves all LC Gate IDs visible to a user for In-App operational notifications,
 * matching the exact Railway Hierarchy jurisdiction used for SMS & Email alerts.
 */
export async function resolveUserAlertGateIds(
  user: any,
  prisma: PrismaClient,
  assignedGateIds: number[] = []
): Promise<number[]> {
  const isDev = isDeveloperUser(user);
  if (isDev) {
    if (assignedGateIds.length > 0) return assignedGateIds;
    const allGatesForDev = await prisma.lCGate.findMany({
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    });
    return allGatesForDev.map((g) => g.id);
  }

  const allGates = await prisma.lCGate.findMany({
    select: { id: true, stationId: true, division: true, zone: true },
  });

  return allGates
    .filter((g) => doesUserMatchGateJurisdiction(user, g, assignedGateIds) !== null)
    .map((g) => g.id);
}

/**
 * Resolves all APPROVED users authorized to review/approve a specific RegistrationRequest,
 * matching exact hierarchical rules (`canApproveRequest`) + `manage-users` permission.
 */
export async function resolveRegistrationApprovers(
  request: any,
  prisma: PrismaClient
): Promise<Array<{
  userId: number;
  fullName: string;
  email: string;
  roleName: string;
  designation: string | null;
}>> {
  const candidates = await prisma.user.findMany({
    where: { status: 'APPROVED' },
    select: {
      id: true,
      fullName: true,
      email: true,
      department: true,
      designation: true,
      zone: true,
      division: true,
      stationId: true,
      roleId: true,
      role: {
        select: {
          id: true,
          name: true,
          roleModules: {
            select: {
              module: { select: { slug: true } },
            },
          },
        },
      },
      assignedGates: { select: { gateId: true } },
    },
  });

  const emailMap = new Map<string, {
    userId: number;
    fullName: string;
    email: string;
    roleName: string;
    designation: string | null;
  }>();

  for (const u of candidates) {
    const isDev = isDeveloperUser(u);
    const allowedModules = (u.role?.roleModules || []).map((m) => m.module.slug);
    const canManageUsers = isDev || allowedModules.includes('manage-users');
    if (!canManageUsers) continue;

    const uGateIds = (u.assignedGates || []).map((ag) => ag.gateId);
    const authCheck = canApproveRequest(u, request, uGateIds);
    if (!isDev && !authCheck.allowed) continue;

    const cleanEmail = (u.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || emailMap.has(cleanEmail)) continue;

    emailMap.set(cleanEmail, {
      userId: u.id,
      fullName: u.fullName || 'Railway Official',
      email: cleanEmail,
      roleName: u.role?.name || u.designation || 'Officer',
      designation: u.designation || null,
    });
  }

  return Array.from(emailMap.values());
}

/**
 * Resolves all authorized SMS and Email alert recipients for a specific LC Gate based strictly on
 * Indian Railways role hierarchy and jurisdiction (Gate, Station, Division, Zone, Developer).
 * Executes a single batched query for zero N+1 overhead.
 */
export async function resolveGateAlertRecipients(
  gateId: number,
  prisma: PrismaClient
): Promise<GateAlertRecipients | null> {
  // 1. Fetch gate and its station
  const gate = await prisma.lCGate.findUnique({
    where: { id: gateId },
    include: { station: true }
  });

  if (!gate) return null;

  // 2. Fetch all APPROVED candidate users with assigned gates
  const candidateUsers = await prisma.user.findMany({
    where: { status: 'APPROVED' },
    select: {
      id: true,
      fullName: true,
      email: true,
      mobile: true,
      department: true,
      designation: true,
      zone: true,
      division: true,
      stationId: true,
      roleId: true,
      role: { select: { id: true, name: true } },
      assignedGates: { select: { gateId: true } }
    }
  });

  const matchedUsers: any[] = [];

  for (const u of candidateUsers) {
    const assignedGateIds = (u.assignedGates || []).map(ag => ag.gateId);
    const reason = doesUserMatchGateJurisdiction(u, gate, assignedGateIds);
    if (reason) {
      matchedUsers.push({ user: u, reason });
    }
  }

  // 3. Partition and deduplicate SMS and Email recipients
  const smsRecipientsMap = new Map<string, any>();
  const emailRecipientsMap = new Map<string, any>();

  for (const item of matchedUsers) {
    const u = item.user;

    // Clean and validate 10-digit mobile
    if (u.mobile) {
      const rawDigits = u.mobile.replace(/\D/g, '');
      let cleanPhone = '';
      if (rawDigits.length === 10) {
        cleanPhone = rawDigits;
      } else if (rawDigits.length === 12 && rawDigits.startsWith('91')) {
        cleanPhone = rawDigits.slice(2);
      } else if (rawDigits.length > 10) {
        cleanPhone = rawDigits.slice(-10);
      }
      if (cleanPhone.length === 10 && !smsRecipientsMap.has(cleanPhone)) {
        smsRecipientsMap.set(cleanPhone, {
          userId: u.id,
          fullName: u.fullName,
          phone: cleanPhone,
          designation: u.designation || u.role?.name || null,
          department: u.department || null,
          reason: item.reason
        });
      }
    }

    // Clean and validate RFC email
    if (u.email) {
      const cleanEmail = u.email.trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) && !emailRecipientsMap.has(cleanEmail)) {
        emailRecipientsMap.set(cleanEmail, {
          userId: u.id,
          fullName: u.fullName,
          email: cleanEmail,
          designation: u.designation || u.role?.name || null,
          department: u.department || null,
          reason: item.reason
        });
      }
    }
  }

  return {
    gate: {
      id: gate.id,
      lcNumber: gate.lcNumber,
      name: gate.name,
      locationName: gate.locationName,
      division: gate.division,
      zone: gate.zone,
      stationId: gate.stationId,
      stationName: gate.station?.name || null
    },
    smsRecipients: Array.from(smsRecipientsMap.values()),
    emailRecipients: Array.from(emailRecipientsMap.values()),
    matchedUsers
  };
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
