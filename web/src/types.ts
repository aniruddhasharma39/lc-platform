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

export type NotificationItem = {
  id: string;
  type: 'user_request' | 'cluster_created' | 'device_registered' | 'device_offline' | 'system';
  priority?: 'P1' | 'P2' | 'P3' | 'P4';
  priorityLabel?: 'CRITICAL' | 'HIGH' | 'INFO' | 'SETUP';
  title: string;
  message: string;
  createdAt: string;
  isRead: boolean;
  targetModule?: string;
};
