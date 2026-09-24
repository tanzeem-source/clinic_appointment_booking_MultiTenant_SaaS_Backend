import { resend } from '../config/resend';
import { env } from '../config/env';

export const sendOtpEmail = async (to: string, otp: string, subject: string) => {
  try {
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in ${env.OTP_EXPIRY_MINUTES} minutes.</p>`
    });
  } catch (err) {
    // Don't fail the request over an email hiccup — the account already
    // exists at this point, and /resend-otp gives the user a retry path.
    console.error('Failed to send OTP email:', err);
  }
};