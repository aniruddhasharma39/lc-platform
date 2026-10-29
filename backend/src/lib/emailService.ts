import nodemailer from 'nodemailer';
import { prisma } from './prisma';

export interface SendEmailResult {
  success: boolean;
  provider?: 'BREVO_API' | 'BREVO_SMTP' | 'SMTP' | 'SIMULATED';
  messageId?: string;
  error?: string;
  reason?: 'SMTP_NOT_CONFIGURED' | 'DELIVERY_FAILED' | 'INVALID_RECIPIENT';
}

/**
 * Creates nodemailer transport using environment variables (SMTP fallback)
 */
function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

/**
 * Format date into Indian Standard Time (IST) string: DD-MM-YYYY HH:mm
 */
function formatIstDateTime(date: Date = new Date()): string {
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
 * Clean & validate email address
 */
function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim();
  if (clean.startsWith('temp-') || clean.includes('@example.com')) return false;
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(clean);
}

/**
 * Send transactional email via Brevo REST API v3 (POST https://api.brevo.com/v3/smtp/email)
 * This runs over standard HTTPS (Port 443) and bypasses any cloud host SMTP port 587/465 blocks.
 */
async function sendViaBrevoApi(options: {
  toEmail: string;
  toName?: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
}): Promise<SendEmailResult> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      reason: 'SMTP_NOT_CONFIGURED',
      error: 'BREVO_API_KEY is not configured in .env',
    };
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER || 'no-reply@lcgate.in';
  const senderName = process.env.BREVO_SENDER_NAME || 'Indian Railways Level Crossing Platform';

  try {
    const payload = {
      sender: {
        name: senderName,
        email: senderEmail,
      },
      to: [
        {
          email: options.toEmail,
          name: options.toName || options.toEmail,
        },
      ],
      subject: options.subject,
      htmlContent: options.htmlContent,
      textContent: options.textContent || undefined,
    };

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data: any = await response.json().catch(() => null);

    if (response.ok && data?.messageId) {
      console.log(`✅ [BREVO API] Dispatched email to ${options.toEmail}. Message ID: ${data.messageId}`);
      return {
        success: true,
        provider: 'BREVO_API',
        messageId: data.messageId,
      };
    } else {
      const errorMsg = data?.message || `Brevo API HTTP ${response.status}: ${response.statusText}`;
      console.warn(`⚠️ [BREVO API] Dispatch failed for ${options.toEmail}: ${errorMsg}`);
      return {
        success: false,
        provider: 'BREVO_API',
        reason: 'DELIVERY_FAILED',
        error: errorMsg,
      };
    }
  } catch (err: any) {
    console.error(`❌ [BREVO API] Network exception delivering to ${options.toEmail}:`, err?.message || err);
    return {
      success: false,
      provider: 'BREVO_API',
      reason: 'DELIVERY_FAILED',
      error: err?.message || 'Network error communicating with Brevo API',
    };
  }
}

/**
 * Universal email dispatcher:
 * 1. Checks BREVO_API_KEY -> Uses Brevo REST API v3
 * 2. Checks SMTP_HOST (Brevo SMTP relay: smtp-relay.brevo.com) -> Uses Nodemailer
 * 3. Graceful fallback with clear diagnostic messages
 */
export async function sendEmail(options: {
  toEmail: string;
  toName?: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
}): Promise<SendEmailResult> {
  const cleanEmail = options.toEmail.trim().toLowerCase();
  if (!isValidEmail(cleanEmail)) {
    return {
      success: false,
      reason: 'INVALID_RECIPIENT',
      error: `Invalid recipient email address: "${options.toEmail}"`,
    };
  }

  // 1. Prioritize Brevo REST API v3 (unaffected by cloud firewall port restrictions)
  if (process.env.BREVO_API_KEY) {
    const apiResult = await sendViaBrevoApi({ ...options, toEmail: cleanEmail });
    if (apiResult.success) {
      return apiResult;
    }
    console.warn(`⚠️ [EMAIL DISPATCH] Brevo API failed (${apiResult.error}). Attempting SMTP fallback...`);
  }

  // 2. Try Nodemailer transport (Brevo SMTP relay or custom SMTP)
  const transporter = getTransporter();
  if (transporter) {
    const fromAddress =
      process.env.SMTP_FROM ||
      (process.env.BREVO_SENDER_EMAIL
        ? `"${process.env.BREVO_SENDER_NAME || 'Indian Railways Level Crossing Platform'}" <${process.env.BREVO_SENDER_EMAIL}>`
        : null) ||
      `"Indian Railways LC Platform" <${process.env.SMTP_USER}>`;

    try {
      const info = await transporter.sendMail({
        from: fromAddress,
        to: cleanEmail,
        subject: options.subject,
        text: options.textContent,
        html: options.htmlContent,
      });

      const isBrevoSmtp = (process.env.SMTP_HOST || '').includes('brevo.com');
      const provider = isBrevoSmtp ? 'BREVO_SMTP' : 'SMTP';

      console.log(`✅ [${provider}] Dispatched email to ${cleanEmail}. Message ID: ${info.messageId}`);
      return {
        success: true,
        provider,
        messageId: info.messageId,
      };
    } catch (err: any) {
      console.error(`❌ [SMTP ERROR] Failed sending to ${cleanEmail}:`, err?.message || err);
      return {
        success: false,
        provider: 'SMTP',
        reason: 'DELIVERY_FAILED',
        error: `SMTP delivery failed: ${err?.message || 'Connection refused'}`,
      };
    }
  }

  // 3. Neither configured
  console.warn(`⚠️ [EMAIL SERVICE] Neither BREVO_API_KEY nor SMTP credentials (SMTP_HOST, SMTP_USER, SMTP_PASS) are configured.`);
  return {
    success: false,
    reason: 'SMTP_NOT_CONFIGURED',
    error: 'Email service is awaiting Brevo/SMTP configuration. Please set BREVO_API_KEY or SMTP credentials in .env.',
  };
}

/**
 * Dispatches an Indian Railways official branded HTML verification OTP email
 */
export async function sendEmailOtp(toEmail: string, otp: string, recipientName?: string): Promise<SendEmailResult> {
  const greeting = recipientName ? `Hello ${recipientName},` : 'Hello Official,';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9;">
      <div style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
        <!-- Official Header -->
        <div style="background-color: #003580; padding: 24px; text-align: center; color: #ffffff;">
          <h2 style="margin: 0; font-size: 15px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600;">GOVERNMENT OF INDIA • MINISTRY OF RAILWAYS</h2>
          <h1 style="margin: 8px 0 0 0; font-size: 21px; font-weight: 700;">Level Crossing Safety & Operations Platform</h1>
        </div>
        <!-- Indian Tricolor Accent -->
        <div style="height: 4px; background: linear-gradient(90deg, #FF6600 0%, #FFFFFF 50%, #046A38 100%);"></div>

        <!-- Body Content -->
        <div style="padding: 32px 28px; color: #1e293b;">
          <p style="font-size: 16px; font-weight: 600; margin: 0 0 16px 0; color: #0f172a;">${greeting}</p>
          <p style="font-size: 14px; line-height: 1.6; color: #475569; margin: 0 0 24px 0;">
            Your 6-digit One-Time Password (OTP) for authentication and password recovery on the Indian Railways Level Crossing Platform is:
          </p>

          <div style="text-align: center; margin: 32px 0;">
            <div style="display: inline-block; background-color: #f8fafc; border: 2px dashed #003580; padding: 16px 36px; border-radius: 10px;">
              <span style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #003580; font-family: 'Courier New', Courier, monospace;">${otp}</span>
            </div>
          </div>

          <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 4px; margin-bottom: 24px;">
            <p style="margin: 0; font-size: 13px; color: #1e40af;">
              ⏱️ This verification code is strictly valid for <strong>10 minutes</strong>. Do not share this code with anyone.
            </p>
          </div>

          <p style="font-size: 12px; color: #94a3b8; margin: 0; text-align: center;">
            If you did not initiate this request, please contact your system administrator immediately.
          </p>
        </div>

        <!-- Official Footer -->
        <div style="background-color: #f8fafc; padding: 18px 24px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #64748b;">
          <p style="margin: 0 0 4px 0; font-weight: 600; color: #334155;">Ministry of Railways — Government of India</p>
          <p style="margin: 0; font-size: 11px; color: #94a3b8;">Level Crossing Automated Safety & Monitoring Platform • Confidential & Official Transmission</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({
    toEmail,
    toName: recipientName,
    subject: `[${otp}] Indian Railways LC Platform — Verification Code`,
    textContent: `Your Indian Railways LC Platform verification code is: ${otp}. It is valid for 10 minutes.`,
    htmlContent,
  });
}

/**
 * Dispatches an Indian Railways official branded Gate State Alert email (OPEN / CLOSED)
 */
export async function sendGateStateEmail(params: {
  toEmail: string;
  toName: string;
  lcNumber: string;
  locationName?: string | null;
  zone?: string | null;
  division?: string | null;
  status: 'OPEN' | 'CLOSED';
  timestampStr: string;
  scopeGroupName: string;
}): Promise<SendEmailResult> {
  const {
    toEmail,
    toName,
    lcNumber,
    locationName = 'N/A',
    zone = 'Indian Railways',
    division = 'Operations',
    status,
    timestampStr,
    scopeGroupName,
  } = params;

  const isOpen = status === 'OPEN';
  const statusColor = isOpen ? '#DC2626' : '#166534';
  const statusBg = isOpen ? '#FEF2F2' : '#F0FDF4';
  const statusBorder = isOpen ? '#EF4444' : '#22C55E';
  const statusText = isOpen ? 'GATE OPEN' : 'GATE CLOSED';
  const statusSubtext = isOpen
    ? 'Level Crossing is OPEN to Road Traffic — Rail Traffic Interlocked'
    : 'Level Crossing is CLOSED to Road Traffic — Tracks Secured for Train Movement';

  const advisoryBox = isOpen
    ? `
      <div style="background-color: #FEF2F2; border-left: 4px solid #DC2626; padding: 14px 18px; border-radius: 6px; margin: 24px 0;">
        <h4 style="margin: 0 0 4px 0; color: #991B1B; font-size: 14px;">⚠️ SAFETY ADVISORY — ROAD TRAFFIC PASSAGE ACTIVE</h4>
        <p style="margin: 0; font-size: 13px; color: #B91C1C; line-height: 1.5;">
          The boom barrier is raised. Road vehicles are currently crossing the railway alignment. Please verify track clearance prior to initiating subsequent train signals.
        </p>
      </div>
    `
    : `
      <div style="background-color: #F0FDF4; border-left: 4px solid #16A34A; padding: 14px 18px; border-radius: 6px; margin: 24px 0;">
        <h4 style="margin: 0 0 4px 0; color: #166534; font-size: 14px;">✅ SAFETY CONFIRMATION — TRACKS SECURED</h4>
        <p style="margin: 0; font-size: 13px; color: #15803D; line-height: 1.5;">
          The boom barrier is fully lowered and locked. Road traffic is stopped. Tracks are secure for designated railway transit.
        </p>
      </div>
    `;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08);">
        <!-- Top Navy Header -->
        <div style="background-color: #003580; padding: 22px; text-align: center; color: #ffffff;">
          <h2 style="margin: 0; font-size: 14px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600;">GOVERNMENT OF INDIA • MINISTRY OF RAILWAYS</h2>
          <h1 style="margin: 6px 0 0 0; font-size: 20px; font-weight: 700;">Level Crossing Operational Alert</h1>
        </div>
        <!-- Indian Tricolor Ribbon -->
        <div style="height: 4px; background: linear-gradient(90deg, #FF6600 0%, #FFFFFF 50%, #046A38 100%);"></div>

        <!-- Main Content -->
        <div style="padding: 28px 24px; color: #1e293b;">
          <p style="font-size: 15px; margin: 0 0 16px 0;">Dear Official <strong>${toName}</strong>,</p>
          <p style="font-size: 14px; color: #475569; margin: 0 0 20px 0; line-height: 1.5;">
            An automated state transition has been detected at your assigned Level Crossing under <strong>${scopeGroupName}</strong>:
          </p>

          <!-- Status Highlight Card -->
          <div style="background-color: ${statusBg}; border: 2px solid ${statusBorder}; border-radius: 10px; padding: 20px; text-align: center; margin: 20px 0;">
            <span style="display: inline-block; background-color: ${statusColor}; color: #ffffff; font-weight: 800; font-size: 18px; letter-spacing: 1.5px; padding: 8px 24px; border-radius: 9999px; text-transform: uppercase;">
              ${statusText}
            </span>
            <p style="margin: 12px 0 0 0; font-size: 14px; font-weight: 600; color: ${statusColor};">
              ${statusSubtext}
            </p>
          </div>

          <!-- Gate Specification Table -->
          <table style="width: 100%; border-collapse: collapse; margin: 24px 0; font-size: 13px;">
            <tbody>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px 12px; font-weight: 600; color: #64748b; width: 40%;">LC Gate Identification:</td>
                <td style="padding: 10px 12px; font-weight: 700; color: #003580; font-size: 15px;">${lcNumber}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;">
                <td style="padding: 10px 12px; font-weight: 600; color: #64748b;">Location Name:</td>
                <td style="padding: 10px 12px; font-weight: 600; color: #1e293b;">${locationName || 'N/A'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px 12px; font-weight: 600; color: #64748b;">Zone / Division:</td>
                <td style="padding: 10px 12px; font-weight: 600; color: #1e293b;">${zone || 'WR'} / ${division || 'Operations'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9; background-color: #f8fafc;">
                <td style="padding: 10px 12px; font-weight: 600; color: #64748b;">Assigned Scope Group:</td>
                <td style="padding: 10px 12px; font-weight: 600; color: #1e293b;">${scopeGroupName}</td>
              </tr>
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px 12px; font-weight: 600; color: #64748b;">Timestamp (IST):</td>
                <td style="padding: 10px 12px; font-weight: 700; color: #0f172a;">${timestampStr}</td>
              </tr>
              <tr style="background-color: #f8fafc;">
                <td style="padding: 10px 12px; font-weight: 600; color: #64748b;">Detection Source:</td>
                <td style="padding: 10px 12px; font-weight: 600; color: #1e293b;">IoT Telemetry & Boom Barrier Sensors</td>
              </tr>
            </tbody>
          </table>

          ${advisoryBox}

          <p style="font-size: 12px; color: #94a3b8; margin: 24px 0 0 0; text-align: center;">
            You received this automated transmission because your official email is authorized for <strong>${scopeGroupName}</strong> alerts.
          </p>
        </div>

        <!-- Official Footer -->
        <div style="background-color: #f8fafc; padding: 18px 24px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #64748b;">
          <p style="margin: 0 0 4px 0; font-weight: 600; color: #334155;">Ministry of Railways — Government of India</p>
          <p style="margin: 0; font-size: 11px; color: #94a3b8;">Automated Level Crossing Safety Monitoring System • Dispatched via Brevo</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const subjectPrefix = isOpen ? '🔴 [ALERT - GATE OPEN]' : '🟢 [ALERT - GATE CLOSED]';
  const subject = `${subjectPrefix} Level Crossing ${lcNumber} is now ${status} (${timestampStr})`;
  const textContent = `Indian Railways Alert: Level Crossing ${lcNumber} (${locationName}) transitioned to ${status} at ${timestampStr} IST. Scope Group: ${scopeGroupName}.`;

  return sendEmail({
    toEmail,
    toName,
    subject,
    textContent,
    htmlContent,
  });
}

export interface GateEmailAlertOptions {
  deviceId?: number | null;
  gateId?: number | null;
  thingName: string;
  serialNumber?: string | null;
  newState: 'OPEN' | 'CLOSED';
  timestamp?: Date;
}

/**
 * Checks scope groups mapped to this gate/device.
 * Resolves all APPROVED users in those scope groups with valid email addresses.
 * Dispatches branded Brevo email alerts and records an audit log.
 */
export async function checkAndDispatchGateStateEmailAlert(options: GateEmailAlertOptions) {
  const { deviceId, gateId, thingName, serialNumber, newState, timestamp = new Date() } = options;

  console.log(`✉️ [GATE STATE EMAIL ALERT] Evaluating email alert: Device "${thingName}" -> Status: ${newState}`);

  // 1. Resolve LC Gate details
  let gate = gateId ? await prisma.lCGate.findUnique({ where: { id: gateId } }) : null;

  if (!gate) {
    const lookupKey = thingName.startsWith('LC-') ? thingName : (serialNumber || thingName);
    gate = await prisma.lCGate.findFirst({
      where: {
        OR: [
          { lcNumber: lookupKey },
          { lcNumber: lookupKey.replace(/-M-/, '-') },
          { name: { contains: lookupKey, mode: 'insensitive' } },
        ],
      },
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
      select: { scopeGroupId: true },
    });
    gateScopeRecords.forEach((r) => scopeGroupIds.add(r.scopeGroupId));
  }

  if (deviceId) {
    const deviceScopeRecords = await prisma.scopeGroupDevice.findMany({
      where: { deviceId },
      select: { scopeGroupId: true },
    });
    deviceScopeRecords.forEach((r) => scopeGroupIds.add(r.scopeGroupId));
  }

  if (scopeGroupIds.size === 0) {
    console.log(`ℹ️ [GATE STATE EMAIL ALERT] No scope groups mapped to gate "${effectiveLcNumber}". Email dispatch skipped.`);
    return { dispatched: 0, reason: 'NO_MAPPED_SCOPE_GROUPS' };
  }

  // 3. Retrieve eligible Scope Groups (matching SMS-enabled policy or alert-enabled groups)
  const eligibleScopeGroups = await prisma.scopeGroup.findMany({
    where: {
      id: { in: Array.from(scopeGroupIds) },
      allowSms: true, // Scope groups enabled for real-time alerting
    },
    include: {
      users: {
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              mobile: true,
              status: true,
              role: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  if (eligibleScopeGroups.length === 0) {
    console.log(`ℹ️ [GATE STATE EMAIL ALERT] Scope groups exist for gate "${effectiveLcNumber}", but alerting is disabled (allowSms is false).`);
    return { dispatched: 0, reason: 'ALERTS_NOT_ALLOWED_IN_SCOPE_GROUPS' };
  }

  // 4. Collect unique authorized APPROVED users with valid email addresses
  const recipientsMap = new Map<string, { user: any; scopeGroupId: number; scopeGroupName: string }>();

  eligibleScopeGroups.forEach((group) => {
    group.users.forEach((su) => {
      const u = su.user;
      if (u.status === 'APPROVED' && isValidEmail(u.email)) {
        const cleanEmail = u.email.trim().toLowerCase();
        if (!recipientsMap.has(cleanEmail)) {
          recipientsMap.set(cleanEmail, {
            user: u,
            scopeGroupId: group.id,
            scopeGroupName: group.name,
          });
        }
      }
    });
  });

  if (recipientsMap.size === 0) {
    console.log(`ℹ️ [GATE STATE EMAIL ALERT] Eligible scope groups found, but no APPROVED users have valid email addresses.`);
    return { dispatched: 0, reason: 'NO_ELIGIBLE_APPROVED_USERS' };
  }

  console.log(`📢 [GATE STATE EMAIL ALERT] Found ${recipientsMap.size} authorized email recipient(s) across scope group(s): ${eligibleScopeGroups.map((g) => g.name).join(', ')}`);

  // 5. Dispatch email to each authorized recipient
  const results = [];

  for (const [email, info] of recipientsMap.entries()) {
    try {
      const emailResult = await sendGateStateEmail({
        toEmail: email,
        toName: info.user.fullName,
        lcNumber: effectiveLcNumber,
        locationName: gate?.locationName || null,
        zone: gate?.zone || 'WR',
        division: gate?.division || 'Operations',
        status: newState,
        timestampStr: dateTimeStr,
        scopeGroupName: info.scopeGroupName,
      });

      // Record in GateStateAlertLog table for audit trail
      await prisma.gateStateAlertLog
        .create({
          data: {
            gateId: effectiveGateId,
            lcNumber: effectiveLcNumber,
            status: newState,
            recipientMobile: info.user.mobile || email,
            recipientName: info.user.fullName,
            scopeGroupId: info.scopeGroupId,
            message: `[BREVO EMAIL ALERT] Gate ${effectiveLcNumber} status changed to ${newState}`,
            provider: emailResult.provider || 'BREVO_API',
            statusResult: emailResult.success ? 'SENT' : 'FAILED',
            details: `Email: ${email} | Result: ${emailResult.messageId || emailResult.error || 'OK'}`,
            sentAt: new Date(),
          },
        })
        .catch((err) => console.error('Failed to log gate state email alert to database:', err));

      results.push({
        user: info.user.fullName,
        email,
        scopeGroup: info.scopeGroupName,
        ...emailResult,
      });
    } catch (err: any) {
      console.error(`❌ [GATE STATE EMAIL ALERT] Failed dispatch to ${email}:`, err);
    }
  }

  return {
    dispatched: results.length,
    lcNumber: effectiveLcNumber,
    newState,
    timestamp: dateTimeStr,
    results,
  };
}
