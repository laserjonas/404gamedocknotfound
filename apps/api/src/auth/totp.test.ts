import { describe, expect, it } from 'vitest';
import { generate } from 'otplib';
import { buildTotpEnrollment, generateTotpSecret, verifyTotpCode } from './totp.js';

describe('generateTotpSecret', () => {
  it('generates a non-empty base32 secret, different each time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a.length).toBeGreaterThan(10);
    expect(a).not.toBe(b);
  });
});

describe('verifyTotpCode', () => {
  it('accepts a code freshly generated for the same secret', async () => {
    const secret = generateTotpSecret();
    const code = await generate({ secret });

    await expect(verifyTotpCode(secret, code)).resolves.toBe(true);
  });

  it('rejects a code generated for a different secret', async () => {
    const secret = generateTotpSecret();
    const otherSecret = generateTotpSecret();
    const codeForOther = await generate({ secret: otherSecret });

    await expect(verifyTotpCode(secret, codeForOther)).resolves.toBe(false);
  });

  it('rejects malformed input without throwing', async () => {
    const secret = generateTotpSecret();

    await expect(verifyTotpCode(secret, 'not-a-code')).resolves.toBe(false);
    await expect(verifyTotpCode(secret, '')).resolves.toBe(false);
    await expect(verifyTotpCode(secret, '12345')).resolves.toBe(false);
  });
});

describe('buildTotpEnrollment', () => {
  it('builds an otpauth URL containing the issuer and username, plus a QR data URL', async () => {
    const secret = generateTotpSecret();
    const { otpauthUrl, qrCodeDataUrl } = await buildTotpEnrollment('alice', secret);

    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUrl).toContain('GameDock');
    expect(otpauthUrl).toContain('alice');
    expect(qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});
