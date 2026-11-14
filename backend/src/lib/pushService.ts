import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import path from 'path';
import fs from 'fs';
import { prisma } from './prisma';

let isFcmInitialized = false;

// Search paths for firebase-service-account.json
const possiblePaths = [
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
  path.join(__dirname, '../../firebase-service-account.json'),
  path.join(process.cwd(), 'firebase-service-account.json'),
  '/var/www/lc-platform/backend/firebase-service-account.json'
].filter(Boolean) as string[];

for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    try {
      const serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!getApps().length) {
        initializeApp({
          credential: cert(serviceAccount)
        });
      }
      isFcmInitialized = true;
      console.log(`🔔 [FIREBASE FCM] Initialized successfully using: ${p}`);
      break;
    } catch (err: any) {
      console.warn(`⚠️ [FIREBASE FCM] Failed to initialize from ${p}:`, err.message);
    }
  }
}

if (!isFcmInitialized) {
  console.log('ℹ️ [FIREBASE FCM] firebase-service-account.json not found yet. Push notifications will be queued or skipped until key is uploaded.');
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Sends a push notification to a specific user by their database User ID
 */
export async function sendPushToUserId(userId: number, payload: PushPayload): Promise<boolean> {
  if (!isFcmInitialized) return false;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, fcmToken: true, fullName: true }
    });

    if (!user || !user.fcmToken) {
      return false;
    }

    return await sendDirectPush(user.fcmToken, payload, user.id);
  } catch (error: any) {
    console.error(`❌ [FCM] Failed sending push to user ${userId}:`, error.message);
    return false;
  }
}

/**
 * Sends a push notification directly to an FCM device token
 */
export async function sendDirectPush(fcmToken: string, payload: PushPayload, userIdToCleanOnStale?: number): Promise<boolean> {
  if (!isFcmInitialized || !fcmToken) return false;

  try {
    await getMessaging().send({
      token: fcmToken,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        priority: 'high',
        notification: {
          channelId: 'lc_gate_alerts',
          sound: 'default',
          priority: 'max',
          defaultVibrateTimings: true,
          defaultSound: true,
        }
      }
    });
    return true;
  } catch (error: any) {
    console.warn(`⚠️ [FCM Send Error]: ${error.code || error.message}`);
    // If token is invalid or uninstalled, clean it up from database
    if (
      userIdToCleanOnStale &&
      (error.code === 'messaging/registration-token-not-registered' ||
       error.code === 'messaging/invalid-registration-token')
    ) {
      await prisma.user.update({
        where: { id: userIdToCleanOnStale },
        data: { fcmToken: null }
      }).catch(() => {});
    }
    return false;
  }
}

/**
 * Sends push notifications to all assigned Gatemen & Restkeepers of an LC Gate
 */
export async function sendPushToGateStaff(gateId: number, payload: PushPayload): Promise<number> {
  if (!isFcmInitialized) return 0;

  try {
    const userGates = await prisma.userGate.findMany({
      where: { gateId },
      include: {
        user: { select: { id: true, fcmToken: true } }
      }
    });

    let sentCount = 0;
    for (const ug of userGates) {
      if (ug.user?.fcmToken) {
        const ok = await sendDirectPush(ug.user.fcmToken, payload, ug.user.id);
        if (ok) sentCount++;
      }
    }
    return sentCount;
  } catch (error: any) {
    console.error(`❌ [FCM] Error sending push to gate ${gateId} staff:`, error.message);
    return 0;
  }
}
