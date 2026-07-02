import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Constant-work dummy verify used when the username does not exist,
 * so login timing does not reveal which usernames are valid.
 */
const DUMMY_HASH = bcrypt.hashSync('gamedock-dummy-password', BCRYPT_ROUNDS);
export async function dummyVerify(): Promise<void> {
  await bcrypt.compare('definitely-not-the-password', DUMMY_HASH);
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters long';
  if (password.length > 256) return 'Password must be at most 256 characters long';
  return null;
}
