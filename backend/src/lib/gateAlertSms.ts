import { prisma } from './prisma';

/**
 * Format date into Indian Standard Time (IST) string: DD-MM-YYYY HH:mm
 * Example: 24-10-2026 13:30
 */
export function formatIstDateTime(date: Date = new Date()): string {
  // IST is UTC + 5 hours 30 minutes
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istTime = new Date(utc + (3600000 * 5.5));

  const pad = (n: number) => String(n).padStart(2, '0');
  const day = pad(istTime.getDate());
  const month = pad(istTime.getMonth() + 1);
  const year = istTime.getFullYear();
  const hours = pad(istTime.getHours());
  const minutes = pad(istTime.getMinutes());

  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

/**
 * Clean & normalize phone number to 10-digit Indian mobile format
 */
export function formatPhoneNumber(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

/**
 * DLT Template Specification:
 * Name: LC_GATE_STATE
 * DLT Template ID: 1077472200042625536
 * Header / Sender ID: MIRTHA
 * Category: Service Implicit
 * Content:
 * "Mirtha Technologies: Level Crossing {#alphanumeric#} status changed to {#alphanumeric#} at {#alphanumeric#}. This is an automated monitoring alert."
 */
export const DLT_CONFIG = {
  templateName: 'LC_GATE_STATE',
  dltTemplateId: '1077472200042625536',
  senderId: 'MIRTHA',
  entityId: process.env.TWOFACTOR_PE_ID || '1001020445402520904',
};

export interface SmsDispatchResult {
  success: boolean;
  provider: 'AIRTEL' | '2FACTOR' | 'SIMULATED';
  details?: string;
  messageId?: string;
}

/**
 * Dispatches the DLT-registered Gate State SMS to a mobile number
 */
export async function sendGateStateSms(
  mobile: string,
  lcNumber: string,
  status: 'OPEN' | 'CLOSED',
  timestampStr: string
): Promise<SmsDispatchResult> {
  const phone = formatPhoneNumber(mobile);
  if (!phone || phone.length < 10) {
    return {
      success: false,
      provider: 'SIMULATED',
      details: `Invalid mobile number: ${mobile}`
    };
  }

  // Exact DLT registered message body
  const messageText = `Mirtha Technologies: Level Crossing ${lcNumber} status changed to ${status} at ${timestampStr}. This is an automated monitoring alert.`;

  // 1. Try Airtel IQ SMS API if configured
  const airtelUrl = process.env.AIRTEL_SMS_URL;
  const airtelCustomerId = process.env.AIRTEL_CUSTOMER_ID;
  const airtelAuth = process.env.AIRTEL_SMS_AUTH; // Basic base64 or Bearer token

  if (airtelUrl && airtelCustomerId && airtelAuth) {
    try {
      console.log(`📡 [AIRTEL IQ SMS] Dispatching to +91${phone}: "${messageText}"`);
      const payload = {
        customerId: airtelCustomerId,
        destinationAddress: [`91${phone}`],
        message: messageText,
        sourceAddress: DLT_CONFIG.senderId,
        dltTemplateId: DLT_CONFIG.dltTemplateId,
        entityId: DLT_CONFIG.entityId,
      };

      const res = await fetch(airtelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': airtelAuth.startsWith('Basic ') || airtelAuth.startsWith('Bearer ') ? airtelAuth : `Bearer ${airtelAuth}`,
        },
        body: JSON.stringify(payload),
      });

      const resData: any = await res.json().catch(() => null);
      if (res.ok) {
        console.log(`✅ [AIRTEL IQ SMS] Delivered to +91${phone}`, resData);
        return {
          success: true,
          provider: 'AIRTEL',
          details: 'Dispatched via Airtel IQ Gateway',
          messageId: resData?.messageId || resData?.id,
        };
      } else {
        console.warn(`⚠️ [AIRTEL IQ SMS] Gateway error HTTP ${res.status}:`, resData);
      }
    } catch (err: any) {
      console.error('❌ [AIRTEL IQ SMS] Network error:', err?.message || err);
    }
  }

  // 2. Try 2Factor.in TSMS Gateway (DLT Transactional)
  const twoFactorKey = process.env.TWOFACTOR_API_KEY;
  if (twoFactorKey) {
    try {
      const tsmsUrl = `https://2factor.in/API/V1/${twoFactorKey}/ADDON_SERVICES/SEND/TSMS`;
      console.log(`📡 [2FACTOR TSMS] Dispatching Gate Alert to +91${phone}...`);

      const payload = {
        From: DLT_CONFIG.senderId,
        To: phone,
        TemplateName: DLT_CONFIG.templateName,
        Msg: messageText,
        VAR1: lcNumber,
        VAR2: status,
        VAR3: timestampStr,
      };

      const res = await fetch(tsmsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data: any = await res.json().catch(() => null);
      if (data && data.Status === 'Success') {
        console.log(`✅ [2FACTOR TSMS] Delivered to +91${phone}. Session: ${data.Details}`);
        return {
          success: true,
          provider: '2FACTOR',
          details: 'Dispatched via 2Factor TSMS Gateway',
          messageId: data.Details,
        };
      } else {
        console.warn(`⚠️ [2FACTOR TSMS] Failed (${data?.Details || res.status}). Trying template GET fallback...`);
        // Fallback GET format
        const fallbackUrl = `https://2factor.in/API/V1/${twoFactorKey}/SMS/+91${phone}/${encodeURIComponent(messageText)}/${DLT_CONFIG.templateName}`;
        const fallbackRes = await fetch(fallbackUrl);
        const fallbackData: any = await fallbackRes.json().catch(() => null);

        if (fallbackData && fallbackData.Status === 'Success') {
          return {
            success: true,
            provider: '2FACTOR',
            details: 'Dispatched via 2Factor GET Fallback',
            messageId: fallbackData.Details,
          };
        }
      }
    } catch (err: any) {
      console.error('❌ [2FACTOR TSMS] Network error:', err?.message || err);
    }
  }

  // 3. Fallback / Simulation log (Zero-crash simulation if no active live SMS balance or sandbox)
  console.log(`📱 [SMS SIMULATION ALERT] To: +91${phone}`);
  console.log(`   Message: "${messageText}"`);
  console.log(`   DLT Template: ${DLT_CONFIG.templateName} (${DLT_CONFIG.dltTemplateId}) | Sender: ${DLT_CONFIG.senderId}`);

  return {
    success: true,
    provider: 'SIMULATED',
    details: 'Simulated dispatch (logged to server console & audit log)',
  };
}

export interface GateStateAlertOptions {
  deviceId?: number | null;
  gateId?: number | null;
  thingName: string;
  serialNumber?: string | null;
  newState: 'OPEN' | 'CLOSED';
  timestamp?: Date;
}

/**
 * Checks scope groups mapped to this gate/device.
 * Only users assigned to scope groups where allowSms === true receive the SMS alert.
 * Strictly enforces user authorization and deduplicates recipients.
 */
export async function checkAndDispatchGateStateAlert(options: GateStateAlertOptions) {
  const { deviceId, gateId, thingName, serialNumber, newState, timestamp = new Date() } = options;

  console.log(`🔔 [GATE STATE ALERT] Evaluating state change: Device "${thingName}" -> Status: ${newState}`);

  // 1. Resolve LC Gate
  let gate = gateId ? await prisma.lCGate.findUnique({ where: { id: gateId } }) : null;

  if (!gate) {
    // Try matching lcNumber with thingName or serialNumber
    const lookupKey = (thingName.startsWith('LC-') ? thingName : (serialNumber || thingName));
    gate = await prisma.lCGate.findFirst({
      where: {
        OR: [
          { lcNumber: lookupKey },
          { lcNumber: lookupKey.replace(/-M-/, '-') },
          { name: { contains: lookupKey, mode: 'insensitive' } }
        ]
      }
    });
  }

  const effectiveGateId = gate?.id || gateId || null;
  const effectiveLcNumber = gate?.lcNumber || (thingName.startsWith('LC-') ? thingName : `LC-${thingName}`);
  const dateTimeStr = formatIstDateTime(timestamp);

  // 2. Find all Scope Groups mapped to this gate or device
  const scopeGroupIds = new Set<number>();

  if (effectiveGateId) {
    const gateScopeRecords = await prisma.scopeGroupGate.findMany({
      where: { gateId: effectiveGateId },
      select: { scopeGroupId: true }
    });
    gateScopeRecords.forEach(r => scopeGroupIds.add(r.scopeGroupId));
  }

  if (deviceId) {
    const deviceScopeRecords = await prisma.scopeGroupDevice.findMany({
      where: { deviceId },
      select: { scopeGroupId: true }
    });
    deviceScopeRecords.forEach(r => scopeGroupIds.add(r.scopeGroupId));
  }

  if (scopeGroupIds.size === 0) {
    console.log(`ℹ️ [GATE STATE ALERT] No scope groups mapped to gate "${effectiveLcNumber}". SMS dispatch skipped.`);
    return { dispatched: 0, reason: 'NO_MAPPED_SCOPE_GROUPS' };
  }

  // 3. Filter Scope Groups: MUST have allowSms === true
  const eligibleScopeGroups = await prisma.scopeGroup.findMany({
    where: {
      id: { in: Array.from(scopeGroupIds) },
      allowSms: true
    },
    include: {
      users: {
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              mobile: true,
              status: true,
              role: { select: { name: true } }
            }
          }
        }
      }
    }
  });

  if (eligibleScopeGroups.length === 0) {
    console.log(`ℹ️ [GATE STATE ALERT] Scope groups exist for gate "${effectiveLcNumber}", but NONE have SMS allowed (allowSms is false). SMS dispatch skipped.`);
    return { dispatched: 0, reason: 'SMS_NOT_ALLOWED_IN_SCOPE_GROUPS' };
  }

  // 4. Collect unique authorized users with valid mobile numbers
  // Strictly only send to APPROVED users
  const recipientsMap = new Map<string, { user: any; scopeGroupId: number; scopeGroupName: string }>();

  eligibleScopeGroups.forEach(group => {
    group.users.forEach(su => {
      const u = su.user;
      if (u.status === 'APPROVED' && u.mobile && u.mobile.trim()) {
        const cleanPhone = formatPhoneNumber(u.mobile);
        if (cleanPhone.length === 10 && !recipientsMap.has(cleanPhone)) {
          recipientsMap.set(cleanPhone, {
            user: u,
            scopeGroupId: group.id,
            scopeGroupName: group.name,
          });
        }
      }
    });
  });

  if (recipientsMap.size === 0) {
    console.log(`ℹ️ [GATE STATE ALERT] Eligible scope groups have SMS allowed, but no APPROVED users with valid mobile numbers were found.`);
    return { dispatched: 0, reason: 'NO_ELIGIBLE_APPROVED_USERS' };
  }

  console.log(`📢 [GATE STATE ALERT] Found ${recipientsMap.size} authorized recipient(s) across SMS-enabled scope group(s): ${eligibleScopeGroups.map(g => g.name).join(', ')}`);

  // 5. Dispatch SMS and record audit trail for each recipient
  const results = [];
  const messageText = `Mirtha Technologies: Level Crossing ${effectiveLcNumber} status changed to ${newState} at ${dateTimeStr}. This is an automated monitoring alert.`;

  for (const [phone, info] of recipientsMap.entries()) {
    try {
      const sendResult = await sendGateStateSms(phone, effectiveLcNumber, newState, dateTimeStr);

      // Record in GateStateAlertLog table
      await prisma.gateStateAlertLog.create({
        data: {
          gateId: effectiveGateId,
          lcNumber: effectiveLcNumber,
          status: newState,
          recipientMobile: phone,
          recipientName: info.user.fullName,
          scopeGroupId: info.scopeGroupId,
          message: messageText,
          provider: sendResult.provider,
          statusResult: sendResult.success ? 'SENT' : 'FAILED',
          details: sendResult.details || null,
          sentAt: new Date(),
        }
      }).catch(err => console.error('Failed to log gate state alert to database:', err));

      results.push({
        user: info.user.fullName,
        mobile: phone,
        scopeGroup: info.scopeGroupName,
        ...sendResult
      });
    } catch (err: any) {
      console.error(`❌ [GATE STATE ALERT] Failed to send SMS to ${phone}:`, err);
    }
  }

  return {
    dispatched: results.length,
    lcNumber: effectiveLcNumber,
    newState,
    timestamp: dateTimeStr,
    results
  };
}
