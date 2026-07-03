import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64urlToBuffer, bufferToBase64url, handleToUserId } from './passkey.js';

describe('passkey base64url helpers', () => {
  it('round-trips arbitrary bytes through base64url encode/decode', () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255, 16, 32, 64, 128]);
    const encoded = bufferToBase64url(original);
    const decoded = base64urlToBuffer(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('produces URL-safe output (no +, /, or = padding)', () => {
    // Bytes chosen so plain base64 would need + and / and padding.
    const bytes = new Uint8Array([251, 239, 190, 255, 255, 254]);
    const encoded = bufferToBase64url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('recovers the exact GameDock user id round-tripped through a WebAuthn user handle', () => {
    const userId = randomUUID();
    // Mirrors userIdToHandle's encoding (utf8 -> base64url) without importing
    // the private helper directly.
    const handle = Buffer.from(userId, 'utf8').toString('base64url');
    expect(handleToUserId(handle)).toBe(userId);
  });
});
