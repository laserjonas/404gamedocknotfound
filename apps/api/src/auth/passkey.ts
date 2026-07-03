import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

const RP_NAME = 'GameDock Manager';

export function bufferToBase64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

// Node's Buffer type is a Uint8Array<ArrayBufferLike>, which strict
// @simplewebauthn/server signatures (Uint8Array<ArrayBuffer> specifically)
// don't accept directly - `new Uint8Array(byteLength)` is the one
// constructor form TypeScript infers as backed by a definite ArrayBuffer,
// so copy into one of those at the boundary rather than wrapping a Buffer.
function toStrictUint8Array(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

export function base64urlToBuffer(value: string): Uint8Array<ArrayBuffer> {
  return toStrictUint8Array(Buffer.from(value, 'base64url'));
}

/** WebAuthn's user.id handle - reuses GameDock's own (non-PII, random) user id. */
function userIdToHandle(userId: string): Uint8Array<ArrayBuffer> {
  return toStrictUint8Array(Buffer.from(userId, 'utf8'));
}

export function handleToUserId(handle: string): string {
  return Buffer.from(base64urlToBuffer(handle)).toString('utf8');
}

export async function buildRegistrationOptions(params: {
  rpID: string;
  userId: string;
  username: string;
  existingCredentialIds: string[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: params.rpID,
    userName: params.username,
    userID: userIdToHandle(params.userId),
    attestationType: 'none',
    excludeCredentials: params.existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'preferred',
    },
  });
}

export async function verifyRegistration(params: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRPID: string;
}): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response: params.response,
    expectedChallenge: params.expectedChallenge,
    expectedOrigin: params.expectedOrigin,
    expectedRPID: params.expectedRPID,
  });
}

/** No allowCredentials - lets the browser prompt for any resident credential (usernameless login). */
export async function buildAuthenticationOptions(
  rpID: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
}

export async function verifyAuthentication(params: {
  response: AuthenticationResponseJSON;
  /** Either the exact expected challenge, or a validator (e.g. one-time-use lookup+delete). */
  expectedChallenge: string | ((challenge: string) => boolean | Promise<boolean>);
  expectedOrigin: string;
  expectedRPID: string;
  credential: WebAuthnCredential;
}): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response: params.response,
    expectedChallenge: params.expectedChallenge,
    expectedOrigin: params.expectedOrigin,
    expectedRPID: params.expectedRPID,
    credential: params.credential,
  });
}

export function parseTransports(json: string | null): AuthenticatorTransportFuture[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as AuthenticatorTransportFuture[];
  } catch {
    return [];
  }
}
