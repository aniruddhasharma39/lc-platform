import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { canApproveRequest } from '../lib/railwayHierarchy';

const router = Router();

router.use(authenticate);

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

// GET all notifications associated with the user's role
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const isDev = user.role === 'Developer';
    const canManageUsers = isDev || user.allowedModules?.includes('manage-users');

    // Retrieve full approver record to accurately evaluate hierarchy and jurisdiction
    const fullUser = await prisma.user.findUnique({
      where: { id: user.id },
      include: { role: true }
    });
    const approver = fullUser || user;

    // Fetch approver's assigned gates if any
    const approverUserGates = await prisma.userGate.findMany({
      where: { userId: user.id },
      select: { gateId: true }
    });
    const approverGateIds = approverUserGates.map(ug => ug.gateId);

    const state = await getUserNotificationState(user.id);
    const dismissedSet = new Set(state.dismissedIds);
    const readSet = new Set(state.readIds);

    const notifications: Array<{
      id: string;
      type: 'user_request' | 'cluster_created' | 'device_registered' | 'system';
      title: string;
      message: string;
      createdAt: string;
      isRead: boolean;
      read: boolean;
      targetModule?: string;
    }> = [];

    // 1. Approved Account Notice: In-app welcome notice when user registration is approved
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
          title: 'Registration Approved',
          message: `Welcome ${fullUser.fullName || 'User'}! Your registration request has been approved.${gateAssignmentMsg}`,
          createdAt: fullUser.createdAt.toISOString(),
          isRead: false,
          read: false,
          targetModule: 'profile'
        });
      }
    }

    // 2. Operational Gate Alerts: In-app bell notifications for Gateman and assigned railway personnel
    // Covers: Gate Closed Confirmation, Gate Opened Confirmation, Extended Closure / Traffic Alert
    // (Active Gate Duty Confirmation is strictly omitted per specification)
    let monitoredGateIds: number[] = [...approverGateIds];
    if (isDev && monitoredGateIds.length === 0) {
      const anyGates = await prisma.lCGate.findMany({
        select: { id: true },
        take: 10,
        orderBy: { updatedAt: 'desc' }
      });
      monitoredGateIds = anyGates.map(g => g.id);
    }

    if (monitoredGateIds.length > 0) {
      const recentGateEvents = await prisma.lCGateEvent.findMany({
        where: {
          gateId: { in: monitoredGateIds }
        },
        include: {
          gate: { select: { id: true, lcNumber: true, locationName: true } }
        },
        orderBy: { updatedAt: 'desc' },
        take: 20
      });

      for (const ev of recentGateEvents) {
        const locSuffix = ev.gate?.locationName ? ` (${ev.gate.locationName})` : '';
        const gateLabel = `Gate ${ev.gate?.lcNumber || '#' + ev.gateId}${locSuffix}`;

        // A. Extended Closure / Traffic Alert (>15 minutes closure)
        if (ev.status === 'EXTENDED_DELAY' || (ev.durationSeconds && ev.durationSeconds >= 900)) {
          const extId = `op_ext_${ev.id}`;
          if (!dismissedSet.has(extId) && !readSet.has(extId)) {
            const durationMins = ev.durationSeconds ? Math.round(ev.durationSeconds / 60) : 15;
            notifications.push({
              id: extId,
              type: 'system',
              title: 'Extended Closure Alert',
              message: `${gateLabel} has remained closed for ${durationMins} minutes. Road traffic congestion alert.`,
              createdAt: (ev.closedAt || ev.updatedAt).toISOString(),
              isRead: false,
              read: false,
              targetModule: 'cluster'
            });
          }
        }

        // B. Gate Closed Confirmation
        if (ev.status === 'CLOSED' || ev.closedAt) {
          const closedId = `op_closed_${ev.id}`;
          if (!dismissedSet.has(closedId) && !readSet.has(closedId)) {
            const timeStr = formatNotificationIstTime(ev.closedAt || ev.updatedAt);
            notifications.push({
              id: closedId,
              type: 'system',
              title: 'Gate Closed',
              message: `${gateLabel} closed to road traffic at ${timeStr}.`,
              createdAt: (ev.closedAt || ev.updatedAt).toISOString(),
              isRead: false,
              read: false,
              targetModule: 'cluster'
            });
          }
        }

        // C. Gate Opened Confirmation
        if (ev.status === 'OPEN' || ev.openedAt) {
          const openId = `op_open_${ev.id}`;
          if (!dismissedSet.has(openId) && !readSet.has(openId)) {
            const timeStr = formatNotificationIstTime(ev.openedAt);
            notifications.push({
              id: openId,
              type: 'system',
              title: 'Gate Opened',
              message: `${gateLabel} opened to road traffic at ${timeStr}.`,
              createdAt: ev.openedAt.toISOString(),
              isRead: false,
              read: false,
              targetModule: 'cluster'
            });
          }
        }
      }
    }

    // 3. New user request for approval: ONLY visible to authorized immediate superiors & Developer
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
        // If dismissed or already read/gone through, do not show
        if (dismissedSet.has(id) || readSet.has(id)) continue;

        // Check if current user is authorized to approve/reject this request
        const authCheck = canApproveRequest(approver, reqItem, approverGateIds);
        if (!isDev && !authCheck.allowed) {
          continue; // User is NOT authorized to review this request; suppress notification
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
          title: 'New Registration Request',
          message: `${applicantName} requested approval${roleText}.`,
          createdAt: reqItem.createdAt.toISOString(),
          isRead: false,
          read: false,
          targetModule: 'manage-users'
        });
      }
    }

    // 4. Gate Creation & Device Hardware Linkages: STRICTLY visible to Developer role only
    if (isDev) {
      const gates = await prisma.lCGate.findMany({
        orderBy: { createdAt: 'desc' },
        take: 15
      });

      for (const gate of gates) {
        const id = `cluster_${gate.id}`;
        if (dismissedSet.has(id) || readSet.has(id)) continue;

        const locSuffix = gate.locationName ? ` (${gate.locationName})` : '';
        notifications.push({
          id,
          type: 'cluster_created',
          title: 'Level Crossing Gate Active',
          message: `Gate ${gate.lcNumber}${locSuffix} has been successfully created and configured.`,
          createdAt: gate.createdAt.toISOString(),
          isRead: false,
          read: false,
          targetModule: 'cluster'
        });
      }

      // Master Controller linkage
      const masters = await prisma.masterUnit.findMany({
        include: { gate: true },
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      for (const master of masters) {
        const id = `master_${master.id}`;
        if (dismissedSet.has(id) || readSet.has(id)) continue;

        const cleanMasterSerial = (master.serialNumber || 'Unit').replace(/^#/, '');
        const gateText = master.gate ? `Gate ${master.gate.lcNumber}` : 'Gate';

        notifications.push({
          id,
          type: 'device_registered',
          title: 'Master Controller Linked',
          message: `Gateway unit ${cleanMasterSerial} is linked to ${gateText}.`,
          createdAt: master.createdAt.toISOString(),
          isRead: false,
          read: false,
          targetModule: 'devices'
        });
      }

      // Child sensors
      const childDevices = await prisma.childDevice.findMany({
        include: { master: { include: { gate: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10
      });

      for (const child of childDevices) {
        const id = `child_${child.id}`;
        if (dismissedSet.has(id) || readSet.has(id)) continue;

        const { title, sensorName } = getFriendlySensorInfo(child.type);
        const gateText = child.master?.gate ? `Gate ${child.master.gate.lcNumber}` : 'Gate';

        notifications.push({
          id,
          type: 'device_registered',
          title,
          message: `${sensorName} is connected to ${gateText}.`,
          createdAt: child.createdAt.toISOString(),
          isRead: false,
          read: false,
          targetModule: 'devices'
        });
      }
    }

    // Sort by latest createdAt descending
    notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const unreadCount = notifications.length;

    res.json({
      notifications,
      unreadCount
    });
  } catch (error) {
    next(error);
  }
});

// Helper to get all current active notification IDs for a user
async function getAllActiveNotificationIds(user: any): Promise<string[]> {
  const isDev = user.role === 'Developer';
  const canManageUsers = isDev || user.allowedModules?.includes('manage-users');
  const ids: string[] = [];

  const approverUserGates = await prisma.userGate.findMany({
    where: { userId: user.id },
    select: { gateId: true }
  });
  const approverGateIds = approverUserGates.map(ug => ug.gateId);

  // User approved welcome notice
  if (user.status === 'APPROVED') {
    ids.push(`user_approved_${user.id}`);
  }

  // Operational gate alerts
  let monitoredGateIds: number[] = [...approverGateIds];
  if (isDev && monitoredGateIds.length === 0) {
    const anyGates = await prisma.lCGate.findMany({ select: { id: true }, take: 10 });
    monitoredGateIds = anyGates.map(g => g.id);
  }

  if (monitoredGateIds.length > 0) {
    const events = await prisma.lCGateEvent.findMany({
      where: { gateId: { in: monitoredGateIds } },
      select: { id: true, status: true, closedAt: true, openedAt: true, durationSeconds: true },
      take: 30
    });
    for (const ev of events) {
      if (ev.status === 'CLOSED' || ev.closedAt) ids.push(`op_closed_${ev.id}`);
      if (ev.status === 'OPEN' || ev.openedAt) ids.push(`op_open_${ev.id}`);
      if (ev.status === 'EXTENDED_DELAY' || (ev.durationSeconds && ev.durationSeconds >= 900)) ids.push(`op_ext_${ev.id}`);
    }
  }

  if (canManageUsers) {
    const pendingRequests = await prisma.registrationRequest.findMany({
      where: { status: 'PENDING' },
      take: 50
    });
    for (const r of pendingRequests) {
      const authCheck = canApproveRequest(user, r, approverGateIds);
      if (isDev || authCheck.allowed) {
        ids.push(`req_${r.id}`);
      }
    }
  }

  // Gate creation & Hardware devices strictly for Developer
  if (isDev) {
    const gates = await prisma.lCGate.findMany({ select: { id: true }, take: 30 });
    for (const g of gates) ids.push(`cluster_${g.id}`);

    const masters = await prisma.masterUnit.findMany({ select: { id: true }, take: 30 });
    for (const m of masters) ids.push(`master_${m.id}`);

    const children = await prisma.childDevice.findMany({ select: { id: true }, take: 30 });
    for (const c of children) ids.push(`child_${c.id}`);
  }

  return ids;
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
