import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { canApproveRequest, isDeveloperUser, resolveUserAlertGateIds } from '../lib/railwayHierarchy';

const router = Router();

router.use(authenticate);

type NotificationPriority = 'P1' | 'P2' | 'P3' | 'P4';
type NotificationPriorityLabel = 'CRITICAL' | 'HIGH' | 'INFO' | 'SETUP';

interface NotificationPayload {
  id: string;
  type: 'user_request' | 'cluster_created' | 'device_registered' | 'system' | 'device_offline';
  priority: NotificationPriority;
  priorityLabel: NotificationPriorityLabel;
  priorityRank: number;
  title: string;
  message: string;
  createdAt: string;
  isRead: boolean;
  read: boolean;
  targetModule?: string;
}

// Helper to get or create user notification state from AppSetting
async function getUserNotificationState(userId: number): Promise<{ readIds: string[]; dismissedIds: string[] }> {
  try {
    const settingKey = `user_notifs_${userId}`;
    const setting = await prisma.appSetting.findUnique({
      where: { key: settingKey }
    });
    if (!setting) {
      return { readIds: [], dismissedIds: [] };
    }
    const parsed = JSON.parse(setting.value);
    return {
      readIds: Array.isArray(parsed.readIds) ? parsed.readIds : [],
      dismissedIds: Array.isArray(parsed.dismissedIds) ? parsed.dismissedIds : []
    };
  } catch {
    return { readIds: [], dismissedIds: [] };
  }
}

async function saveUserNotificationState(userId: number, state: { readIds: string[]; dismissedIds: string[] }) {
  const settingKey = `user_notifs_${userId}`;
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({
    where: { key: settingKey },
    create: { key: settingKey, value },
    update: { value }
  });
}

function formatNotificationIstTime(dateVal: Date | string | null | undefined): string {
  if (!dateVal) return '';
  const d = typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
  if (!d || isNaN(d.getTime())) return '';
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  const hours = ist.getHours();
  const minutes = String(ist.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const day = String(ist.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[ist.getMonth()];
  return `${displayHours}:${minutes} ${ampm} (${day} ${month})`;
}

function getFriendlySensorInfo(childType: string): { title: string; sensorName: string } {
  const t = (childType || '').toUpperCase();
  if (t.includes('TILT')) {
    return { title: 'Sensor Connected', sensorName: 'Boom Angle Tilt Sensor' };
  }
  if (t.includes('LIMIT')) {
    return { title: 'Sensor Connected', sensorName: 'Barrier Lock Limit Switch' };
  }
  if (t.includes('HALL') || t.includes('PROXIMITY')) {
    return { title: 'Sensor Connected', sensorName: 'Vehicle Proximity Sensor' };
  }
  if (t.includes('SOLAR') || t.includes('POWER') || t.includes('BATTERY')) {
    return { title: 'Hardware Connected', sensorName: 'Power & Battery Monitor' };
  }
  if (t.includes('SIREN') || t.includes('HOOTER') || t.includes('ALARM')) {
    return { title: 'Hardware Connected', sensorName: 'Audible Hooter & Alarm' };
  }
  if (t.includes('SIGNAL') || t.includes('TRAFFIC')) {
    return { title: 'Hardware Connected', sensorName: 'Road Traffic Signal' };
  }
  const clean = (childType || 'Peripheral').replace(/_/g, ' ').toLowerCase();
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
  return { title: 'Sensor Connected', sensorName: `${capitalized} Sensor` };
}

/**
 * Shared generator for active prioritized notifications for a user (used by GET / and bulk clear/read).
 */
async function buildUserNotifications(
  user: any,
  state: { readIds: string[]; dismissedIds: string[] }
): Promise<NotificationPayload[]> {
  const isDev = isDeveloperUser(user);
  const canManageUsers = isDev || user.allowedModules?.includes('manage-users');

  const fullUser = await prisma.user.findUnique({
    where: { id: user.id },
    include: { role: true }
  });
  const approver = fullUser || user;

  const approverUserGates = await prisma.userGate.findMany({
    where: { userId: user.id },
    select: { gateId: true }
  });
  const approverGateIds = approverUserGates.map(ug => ug.gateId);

  const dismissedSet = new Set(state.dismissedIds);
  const readSet = new Set(state.readIds);
  const notifications: NotificationPayload[] = [];

  // P1 — CRITICAL (Admin Only): Hardware OFFLINE (> 65 minutes silent)
  if (isDev) {
    const offlineDevices = await prisma.deviceRegistry.findMany({
      where: {
        connectivityStatus: 'OFFLINE',
        OR: [{ gateId: { not: null } }, { lastSeenAt: { not: null } }],
      },
      include: {
        gate: { select: { lcNumber: true, locationName: true } },
        master: { select: { serialNumber: true } },
      },
      orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
      take: 15,
    });

    for (const dev of offlineDevices) {
      const epochStamp = dev.lastSeenAt ? new Date(dev.lastSeenAt).getTime() : 'init';
      const offlineId = `offline_${dev.id}_${epochStamp}`;
      if (dismissedSet.has(offlineId) || readSet.has(offlineId)) continue;

      const unitLabel = dev.master?.serialNumber || dev.thingName;
      const gateText = dev.gate?.lcNumber ? `at Gate ${dev.gate.lcNumber}` : '(Unassigned Hardware)';
      const detectedAt = (dev.lastSeenAt || dev.updatedAt || new Date()).toISOString();

      notifications.push({
        id: offlineId,
        type: 'device_offline',
        priority: 'P1',
        priorityLabel: 'CRITICAL',
        priorityRank: 1,
        title: 'Hardware Offline',
        message: `Master Unit ${unitLabel} ${gateText} stopped reporting (> 65m).`,
        createdAt: detectedAt,
        isRead: false,
        read: false,
        targetModule: 'devices',
      });
    }
  }

  // P1 — CRITICAL: Operational Gate Alerts (Extended Delay & Live Gate OPEN — normal CLOSED omitted)
  // Jurisdiction synced with Railway Hierarchy (Gateman / Station / Division / Zone / Developer)
  const monitoredGateIds = await resolveUserAlertGateIds(approver, prisma, approverGateIds);
  if (monitoredGateIds.length > 0) {
    const recentGateEvents = await prisma.lCGateEvent.findMany({
      where: { gateId: { in: monitoredGateIds } },
      include: {
        gate: { select: { id: true, lcNumber: true, locationName: true } }
      },
      orderBy: { updatedAt: 'desc' },
      take: 25
    });

    const nowMs = Date.now();
    for (const ev of recentGateEvents) {
      const locSuffix = ev.gate?.locationName ? ` (${ev.gate.locationName})` : '';
      const gateLabel = `Gate ${ev.gate?.lcNumber || '#' + ev.gateId}${locSuffix}`;

      // A. Extended Delay Alert (>= 15 minutes open/cycle duration)
      const isLiveExtendedOpen = ev.status === 'OPEN' && !ev.closedAt && (nowMs - new Date(ev.openedAt).getTime()) >= 900000;
      const isRecordedExtended = ev.status === 'EXTENDED_DELAY' || (ev.durationSeconds && ev.durationSeconds >= 900);

      if (isLiveExtendedOpen || isRecordedExtended) {
        const extId = `op_ext_${ev.id}`;
        if (!dismissedSet.has(extId) && !readSet.has(extId)) {
          const durationMins = isLiveExtendedOpen
            ? Math.max(15, Math.round((nowMs - new Date(ev.openedAt).getTime()) / 60000))
            : (ev.durationSeconds ? Math.round(ev.durationSeconds / 60) : 15);
          notifications.push({
            id: extId,
            type: 'system',
            priority: 'P1',
            priorityLabel: 'CRITICAL',
            priorityRank: 1,
            title: 'Extended Gate Alert',
            message: isLiveExtendedOpen
              ? `${gateLabel} has remained OPEN for ${durationMins} minutes. Check crossing status.`
              : `${gateLabel} recorded an extended open cycle of ${durationMins} minutes.`,
            createdAt: (ev.closedAt || ev.updatedAt).toISOString(),
            isRead: false,
            read: false,
            targetModule: 'lc-gates',
          });
        }
      }

      // B. Gate Opened Confirmation (Live OPEN gates only — normal CLOSED cycles omitted per specification)
      if (ev.status === 'OPEN' && !ev.closedAt) {
        const openId = `op_open_${ev.id}`;
        if (!dismissedSet.has(openId) && !readSet.has(openId)) {
          const timeStr = formatNotificationIstTime(ev.openedAt);
          notifications.push({
            id: openId,
            type: 'system',
            priority: 'P1',
            priorityLabel: 'CRITICAL',
            priorityRank: 1,
            title: 'Gate Opened',
            message: `${gateLabel} opened to road traffic at ${timeStr}.`,
            createdAt: ev.openedAt.toISOString(),
            isRead: false,
            read: false,
            targetModule: 'lc-gates',
          });
        }
      }
    }
  }

  // P2 — HIGH: New Registration Requests (authorized immediate superiors & Developer)
  if (canManageUsers) {
    const [pendingRequests, roles] = await Promise.all([
      prisma.registrationRequest.findMany({
        where: { status: 'PENDING' },
        include: { form: true },
        orderBy: { createdAt: 'desc' },
        take: 30
      }),
      prisma.role.findMany({ select: { id: true, name: true } })
    ]);
    const roleMap = new Map<number, string>(roles.map(r => [r.id, r.name]));

    for (const reqItem of pendingRequests) {
      const id = `req_${reqItem.id}`;
      if (dismissedSet.has(id) || readSet.has(id)) continue;

      const authCheck = canApproveRequest(approver, reqItem, approverGateIds);
      if (!isDev && !authCheck.allowed) {
        continue;
      }

      let applicantName = 'New Applicant';
      let requestedRole = '';
      try {
        const reqData = JSON.parse(reqItem.data || '{}');
        if (reqData.fullName) applicantName = reqData.fullName;
        if (reqData.roleName) requestedRole = reqData.roleName;
        else if (reqData.role) requestedRole = reqData.role;
        else if (reqData.designation) requestedRole = reqData.designation;
      } catch {}

      if (!requestedRole && reqItem.requestedRoleId && roleMap.has(reqItem.requestedRoleId)) {
        requestedRole = roleMap.get(reqItem.requestedRoleId)!;
      } else if (!requestedRole && reqItem.designation) {
        requestedRole = reqItem.designation;
      }

      const roleText = requestedRole ? ` for ${requestedRole} role` : '';

      notifications.push({
        id,
        type: 'user_request',
        priority: 'P2',
        priorityLabel: 'HIGH',
        priorityRank: 2,
        title: 'New Registration Request',
        message: `${applicantName} requested approval${roleText}.`,
        createdAt: reqItem.createdAt.toISOString(),
        isRead: false,
        read: false,
        targetModule: 'manage-users',
      });
    }
  }

  // P3 — INFO: Approved Account Notice (in-app welcome notice for approved user)
  if (fullUser && fullUser.status === 'APPROVED') {
    const approvedNotifId = `user_approved_${user.id}`;
    if (!dismissedSet.has(approvedNotifId) && !readSet.has(approvedNotifId)) {
      let gateAssignmentMsg = '';
      if (approverGateIds.length > 0) {
        const assignedGates = await prisma.lCGate.findMany({
          where: { id: { in: approverGateIds } },
          select: { lcNumber: true, locationName: true }
        });
        const gateNames = assignedGates
          .map(g => `Gate ${g.lcNumber}${g.locationName ? ` (${g.locationName})` : ''}`)
          .join(', ');
        if (gateNames) {
          gateAssignmentMsg = ` You are assigned to ${gateNames}.`;
        }
      }

      notifications.push({
        id: approvedNotifId,
        type: 'system',
        priority: 'P3',
        priorityLabel: 'INFO',
        priorityRank: 3,
        title: 'Registration Approved',
        message: `Welcome ${fullUser.fullName || 'User'}! Your registration request has been approved.${gateAssignmentMsg}`,
        createdAt: fullUser.createdAt.toISOString(),
        isRead: false,
        read: false,
        targetModule: 'profile',
      });
    }
  }

  // P4 — SETUP (Developer / System Admin ONLY): Gate Creation & Hardware Linkages
  if (isDev) {
    const [gates, masters, childDevices] = await Promise.all([
      prisma.lCGate.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
      prisma.masterUnit.findMany({ include: { gate: true }, orderBy: { createdAt: 'desc' }, take: 10 }),
      prisma.childDevice.findMany({ include: { master: { include: { gate: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

    for (const gate of gates) {
      const id = `cluster_${gate.id}`;
      if (dismissedSet.has(id) || readSet.has(id)) continue;

      const locSuffix = gate.locationName ? ` (${gate.locationName})` : '';
      notifications.push({
        id,
        type: 'cluster_created',
        priority: 'P4',
        priorityLabel: 'SETUP',
        priorityRank: 4,
        title: 'Level Crossing Gate Active',
        message: `Gate ${gate.lcNumber}${locSuffix} has been successfully created and configured.`,
        createdAt: gate.createdAt.toISOString(),
        isRead: false,
        read: false,
        targetModule: 'cluster',
      });
    }

    for (const master of masters) {
      const id = `master_${master.id}`;
      if (dismissedSet.has(id) || readSet.has(id)) continue;

      const cleanMasterSerial = (master.serialNumber || 'Unit').replace(/^#/, '');
      const gateText = master.gate ? `Gate ${master.gate.lcNumber}` : 'Gate';

      notifications.push({
        id,
        type: 'device_registered',
        priority: 'P4',
        priorityLabel: 'SETUP',
        priorityRank: 4,
        title: 'Master Controller Linked',
        message: `Gateway unit ${cleanMasterSerial} is linked to ${gateText}.`,
        createdAt: master.createdAt.toISOString(),
        isRead: false,
        read: false,
        targetModule: 'devices',
      });
    }

    for (const child of childDevices) {
      const id = `child_${child.id}`;
      if (dismissedSet.has(id) || readSet.has(id)) continue;

      const { title, sensorName } = getFriendlySensorInfo(child.type);
      const gateText = child.master?.gate ? `Gate ${child.master.gate.lcNumber}` : 'Gate';

      notifications.push({
        id,
        type: 'device_registered',
        priority: 'P4',
        priorityLabel: 'SETUP',
        priorityRank: 4,
        title,
        message: `${sensorName} is connected to ${gateText}.`,
        createdAt: child.createdAt.toISOString(),
        isRead: false,
        read: false,
        targetModule: 'devices',
      });
    }
  }

  // Sort strictly by Priority Rank (P1 -> P4), then newest timestamp first
  notifications.sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) {
      return a.priorityRank - b.priorityRank;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return notifications;
}

// GET all notifications associated with the user's role
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const state = await getUserNotificationState(user.id);
    const items = await buildUserNotifications(user, state);
    const notifications = items.map(({ priorityRank: _rank, ...rest }) => rest);

    res.json({
      notifications,
      unreadCount: notifications.length,
    });
  } catch (error) {
    next(error);
  }
});

async function getAllActiveNotificationIds(user: any): Promise<string[]> {
  const items = await buildUserNotifications(user, { readIds: [], dismissedIds: [] });
  return items.map((n) => n.id);
}

// Mark all notifications as read & clear them
router.post('/read-all', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const { notificationIds } = req.body;
    const state = await getUserNotificationState(user.id);

    const newReadSet = new Set(state.readIds);
    const newDismissedSet = new Set(state.dismissedIds);

    if (Array.isArray(notificationIds) && notificationIds.length > 0) {
      notificationIds.forEach(id => {
        newReadSet.add(id);
        newDismissedSet.add(id);
      });
    } else {
      const allIds = await getAllActiveNotificationIds(user);
      allIds.forEach(id => {
        newReadSet.add(id);
        newDismissedSet.add(id);
      });
    }
    state.readIds = Array.from(newReadSet);
    state.dismissedIds = Array.from(newDismissedSet);

    await saveUserNotificationState(user.id, state);
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    next(error);
  }
});

// Clear (dismiss) all notifications
router.post('/clear-all', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const state = await getUserNotificationState(user.id);
    const allIds = await getAllActiveNotificationIds(user);

    const newDismissedSet = new Set(state.dismissedIds);
    const newReadSet = new Set(state.readIds);

    allIds.forEach(id => {
      newDismissedSet.add(id);
      newReadSet.add(id);
    });
    state.dismissedIds = Array.from(newDismissedSet);
    state.readIds = Array.from(newReadSet);

    await saveUserNotificationState(user.id, state);
    res.json({ success: true, message: 'All notifications cleared' });
  } catch (error) {
    next(error);
  }
});

// Mark single notification as read & dismissed so it goes away once viewed
router.put('/:id/read', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const notifId = req.params.id;
    const state = await getUserNotificationState(user.id);

    if (!state.readIds.includes(notifId)) {
      state.readIds.push(notifId);
    }
    if (!state.dismissedIds.includes(notifId)) {
      state.dismissedIds.push(notifId);
    }
    await saveUserNotificationState(user.id, state);

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Dismiss single notification
router.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const notifId = req.params.id;
    const state = await getUserNotificationState(user.id);

    if (!state.dismissedIds.includes(notifId)) {
      state.dismissedIds.push(notifId);
    }
    if (!state.readIds.includes(notifId)) {
      state.readIds.push(notifId);
    }
    await saveUserNotificationState(user.id, state);

    res.json({ success: true, message: 'Notification dismissed' });
  } catch (error) {
    next(error);
  }
});

export default router;
