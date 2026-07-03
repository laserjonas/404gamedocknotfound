import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

const ISSUER = 'GameDock';
/** Accept codes from one time-step (30s) on either side to tolerate clock drift. */
const EPOCH_TOLERANCE_SECONDS = 30;

const RECOVERY_CODE_COUNT = 10;
// No 0/O/1/I/L - avoids transcription mistakes when a user copies these down by hand.
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let raw = '';
  for (const byte of bytes) {
    raw += RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** A fresh batch of one-time-use 2FA recovery codes, e.g. "7KQP2-4RTXM". Shown to the user once. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
}

/** Distinguishes a recovery code from a 6-digit TOTP code at the login-verification step. */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Z0-9]{5}-[A-Z0-9]{5}$/i.test(code.trim());
}

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
