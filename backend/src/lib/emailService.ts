import nodemailer from 'nodemailer';

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  reason?: 'SMTP_NOT_CONFIGURED' | 'DELIVERY_FAILED';
}

/**
 * Creates nodemailer transport using environment variables
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
 * Dispatches an Indian Railways official branded HTML verification OTP email
 */
export async function sendEmailOtp(toEmail: string, otp: string): Promise<SendEmailResult> {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn(`⚠️ [EMAIL OTP] SMTP credentials not configured in .env (SMTP_HOST, SMTP_USER, SMTP_PASS).`);
    return {
      success: false,
      reason: 'SMTP_NOT_CONFIGURED',
      error: 'Email OTP service is not configured on this server. Please contact administrator or log in using Mobile Number OTP.',
    };
  }

  const fromAddress = process.env.SMTP_FROM || `"Indian Railways LC Platform" <${process.env.SMTP_USER}>`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 580px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
      <div style="background-color: #003580; padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 18px; letter-spacing: 1px; text-transform: uppercase;">GOVERNMENT OF INDIA — MINISTRY OF RAILWAYS</h2>
        <h1 style="margin: 8px 0 0 0; font-size: 22px;">Level Crossing Safety & Operations Platform</h1>
      </div>
      <div style="height: 4px; background: linear-gradient(90deg, #FF6600 0%, #FFFFFF 50%, #046A38 100%);"></div>
      
      <div style="padding: 32px 24px; background-color: #ffffff; color: #1e293b;">
        <p style="font-size: 15px; margin: 0 0 16px 0;">Hello Official,</p>
        <p style="font-size: 14px; line-height: 1.5; color: #475569; margin: 0 0 24px 0;">
          Your 6-digit One-Time Password (OTP) for authentication and password recovery on the Indian Railways Level Crossing Platform is:
        </p>
        
        <div style="text-align: center; margin: 30px 0;">
          <div style="display: inline-block; background-color: #f1f5f9; border: 2px dashed #003580; padding: 14px 32px; border-radius: 8px;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #003580; font-family: monospace;">${otp}</span>
          </div>
        </div>

        <p style="font-size: 13px; color: #64748b; margin: 24px 0 0 0; text-align: center;">
          ⏱️ This verification code is strictly valid for <strong>10 minutes</strong>.
        </p>
        <p style="font-size: 12px; color: #94a3b8; margin: 16px 0 0 0; text-align: center;">
          If you did not request this OTP, please ignore this email or notify your system administrator.
        </p>
      </div>

      <div style="background-color: #f8fafc; padding: 16px 24px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 11px; color: #94a3b8;">
        Official Indian Railways Monitoring Platform • Confidential & Proprietary
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from: fromAddress,
      to: toEmail,
      subject: `[${otp}] Your Indian Railways LC Platform Verification Code`,
      text: `Your Indian Railways LC Platform verification code is: ${otp}. It is valid for 10 minutes.`,
      html: htmlContent,
    });

    console.log(`✅ [EMAIL OTP] Dispatched verification code to ${toEmail}. Message ID: ${info.messageId}`);
    return {
      success: true,
      messageId: info.messageId,
    };
  } catch (err: any) {
    console.error(`❌ [EMAIL OTP] Failed to send email to ${toEmail}:`, err?.message || err);
    return {
      success: false,
      reason: 'DELIVERY_FAILED',
      error: `Failed to deliver email: ${err?.message || 'SMTP network error'}. Please check SMTP configuration.`,
    };
  }
}
