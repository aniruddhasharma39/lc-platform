export type User = {
  id: number;
  fullName: string;
  email: string;
  mobile?: string;
  employeeId?: string;
  department?: string;
  role: string;
  metadata?: string;
  createdAt?: string;
  status?: string;
  allowedModules: string[];
  scopeGroups?: {
    id: number;
    name: string;
    color?: string | null;
    description?: string | null;
  }[];
};

export type ChildDeviceItem = {
  id: number;
  serialNumber: string;
  deviceSequence: number;
  type: string;
  masterId: number;
  evidences?: any[];
};

export type MasterUnitItem = {
  id: number;
  serialNumber: string;
  masterSequence: number;
  powerSource: 'SOLAR' | 'DIRECT';
  gateId: number;
  childDevices?: ChildDeviceItem[];
  evidences?: any[];
};

export type ScopeGroupItem = {
  id: number;
  name: string;
  description?: string | null;
  color?: string | null;
  parentId?: number | null;
  parent?: { id: number; name: string; color?: string | null; parentId?: number | null } | null;
  children?: {
    id: number;
    name: string;
    color?: string | null;
    parentId?: number | null;
    _count?: { gates: number; children: number };
  }[];
  breadcrumbs?: { id: number; name: string; color?: string | null }[];
  createdAt?: string;
  updatedAt?: string;
  _count?: {
    gates: number;
    users: number;
    children?: number;
  };
  gates?: {
    gate: {
      id: number;
      name?: string | null;
      lcNumber: string;
      locationName: string;
      zone?: string | null;
      division?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      masters?: MasterUnitItem[];
    };
  }[];
  users?: {
    user: {
      id: number;
      fullName: string;
      email: string;
      mobile?: string | null;
      department?: string | null;
      role?: { id: number; name: string } | null;
    };
  }[];
};

export type NotificationItem = {
  id: string;
  type: 'user_request' | 'cluster_created' | 'device_registered' | 'system';
  title: string;
  message: string;
  createdAt: string;
  isRead: boolean;
  targetModule?: string;
};
