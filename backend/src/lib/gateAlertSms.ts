import { prisma } from './prisma';
import { resolveGateAlertRecipients } from './railwayHierarchy';
import { checkAndDispatchGateStateEmailAlert, GateEmailAlertOptions } from './emailService';

export { checkAndDispatchGateStateEmailAlert };

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
  masterId?: number | null;
  masterSerial?: string | null;
  thingName: string;
  serialNumber?: string | null;
  newState: 'OPEN' | 'CLOSED';
  timestamp?: Date;
}

/**
 * Checks authorized recipients mapped to this gate/device.
 * Strictly dispatches alerts only when the device is assigned to an LC Gate.
 */
export async function checkAndDispatchGateStateAlert(options: GateStateAlertOptions) {
  const { deviceId, gateId, masterId, masterSerial, thingName, serialNumber, newState, timestamp = new Date() } = options;

  // Normal CLOSED alerts are disabled (only OPEN & Extended alerts are dispatched)
  if (newState !== 'OPEN') {
    return { dispatched: 0, dispatchedEmails: 0, reason: 'CLOSED_NOTIFICATIONS_DISABLED', emailResults: [] };
  }

  console.log(`🔔 [GATE STATE ALERT] Evaluating state change: Device "${thingName}" -> Status: ${newState}`);

  // 1. Resolve LC Gate strictly from explicit assignment (no fuzzy fallback guessing)
  let resolvedGateId = gateId ?? null;
  let resolvedMasterId = masterId ?? null;
  let resolvedMasterSerial = masterSerial ?? null;

  if (!resolvedGateId) {
    const foundDev = await prisma.deviceRegistry.findFirst({
      where: deviceId ? { id: deviceId } : { thingName },
      select: {
        gateId: true,
        masterId: true,
        master: { select: { serialNumber: true } },
      }
    });
    if (foundDev?.gateId) resolvedGateId = foundDev.gateId;
    if (!resolvedMasterId && foundDev?.masterId) resolvedMasterId = foundDev.masterId;
    if (!resolvedMasterSerial && foundDev?.master?.serialNumber) resolvedMasterSerial = foundDev.master.serialNumber;
  }

  if (!resolvedGateId) {
    console.log(`ℹ️ [GATE STATE ALERT] Device "${thingName}" is unassigned; skipping gate alerts.`);
    return { dispatched: 0, dispatchedEmails: 0, reason: 'DEVICE_UNASSIGNED', emailResults: [] };
  }

  const gate = await prisma.lCGate.findUnique({
    where: { id: resolvedGateId },
    include: { masters: { select: { id: true, serialNumber: true } } }
  });
  if (!gate) {
    return { dispatched: 0, dispatchedEmails: 0, reason: 'GATE_NOT_FOUND', emailResults: [] };
  }

  if (!resolvedMasterSerial && resolvedMasterId) {
    const m = gate.masters.find(x => x.id === resolvedMasterId);
    if (m?.serialNumber) resolvedMasterSerial = m.serialNumber;
  }

  const isMultiMaster = gate.masters.length > 1;
  const effectiveGateId = gate.id;
  // Use Master Serial (e.g. LC-47-01) when multiple masters exist on a single gate so DLT variable identifies which unit moved
  const smsIdentifier = (isMultiMaster && resolvedMasterSerial) ? resolvedMasterSerial : gate.lcNumber;
  const effectiveLcNumber = gate.lcNumber;
  const dateTimeStr = formatIstDateTime(timestamp);

  // 2. Resolve authorized recipients using Indian Railways hierarchy
  const recipientsData = await resolveGateAlertRecipients(effectiveGateId, prisma);

  const smsRecipients = recipientsData?.smsRecipients || [];

  const enrichedEmailOptions: GateEmailAlertOptions = {
    ...options,
    gateId: effectiveGateId,
    masterId: resolvedMasterId,
    masterSerial: resolvedMasterSerial,
  };

  if (smsRecipients.length === 0) {
    console.log(`⚠️ [GATE STATE ALERT] No eligible APPROVED users with valid mobile numbers found for gate ${effectiveLcNumber}.`);
    const emailAlertResult = await checkAndDispatchGateStateEmailAlert(enrichedEmailOptions).catch((err) => {
      console.error("❌ [GATE STATE ALERT] Error dispatching email alerts:", err?.message || err);
      return null;
    });
    return {
      dispatched: 0,
      dispatchedEmails: emailAlertResult?.dispatched || 0,
      reason: 'NO_ELIGIBLE_APPROVED_USERS',
      emailResults: emailAlertResult?.results || []
    };
  }

  console.log(`🔔 [GATE STATE ALERT] Found ${smsRecipients.length} authorized SMS recipient(s) across Railway Hierarchy.`);
  // 5. Dispatch SMS and record audit trail for each recipient
  const results = [];
  const messageText = `Mirtha Technologies: Level Crossing ${smsIdentifier} status changed to ${newState} at ${dateTimeStr}. This is an automated monitoring alert.`;

  for (const recipient of smsRecipients) {
    try {
      const sendResult = await sendGateStateSms(recipient.phone, smsIdentifier, newState, dateTimeStr);

      // Record in GateStateAlertLog table
      await prisma.gateStateAlertLog.create({
        data: {
          gateId: effectiveGateId,
          lcNumber: smsIdentifier,
          status: newState,
          recipientMobile: recipient.phone,
          recipientName: recipient.fullName,
           scopeGroupId: null,
          message: messageText,
          provider: sendResult.provider,
          statusResult: sendResult.success ? 'SENT' : 'FAILED',
          details: sendResult.details || null,
          sentAt: new Date(),
        }
      }).catch(err => console.error('Failed to log gate state alert to database:', err));

      results.push({
        user: recipient.fullName,
        mobile: recipient.phone,
        designation: recipient.designation,
        department: recipient.department,
        reason: recipient.reason,
         scopeGroup: null,
        ...sendResult
      });
    } catch (err: any) {
      console.error(`❌ [GATE STATE ALERT] Failed to send SMS to ${recipient.phone}:`, err);
    }
  }

  // Also dispatch Brevo email alerts in parallel for authorized users with email
  const emailAlertResult = await checkAndDispatchGateStateEmailAlert(enrichedEmailOptions).catch((err) => {
    console.error("❌ [GATE STATE ALERT] Error dispatching email alerts:", err?.message || err);
    return null;
  });

  return {
    dispatched: results.length,
    dispatchedEmails: emailAlertResult?.dispatched || 0,
    lcNumber: effectiveLcNumber,
    newState,
    timestamp: dateTimeStr,
    results,
    emailResults: emailAlertResult?.results || [],
  };
}
