import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

const ISSUER = 'GameDock';
/** Accept codes from one time-step (30s) on either side to tolerate clock drift. */
const EPOCH_TOLERANCE_SECONDS = 30;

/** Generates a new base32 TOTP secret for a pending 2FA setup. */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** Verifies a 6-digit code against a stored secret. */
export async function verifyTotpCode(secret: string, code: string): Promise<boolean> {
  const token = code.trim();
  if (!/^\d{6}$/.test(token)) return false;
  try {
    const result = await verify({ secret, token, epochTolerance: EPOCH_TOLERANCE_SECONDS });
    return result.valid;
  } catch {
    return false;
  }
}

/** Builds the otpauth:// URL and a scannable QR code (PNG data URL) for setup. */
export async function buildTotpEnrollment(
  username: string,
  secret: string,
): Promise<{ otpauthUrl: string; qrCodeDataUrl: string }> {
  const otpauthUrl = generateURI({ issuer: ISSUER, label: username, secret });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { otpauthUrl, qrCodeDataUrl };
}
