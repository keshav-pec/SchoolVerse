import bcrypt from 'bcryptjs';
import { isTest } from '../../config/env';

const COST = isTest ? 4 : 12;

export function hashPassword(plain: string) {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string) {
  return bcrypt.compare(plain, hash);
}

/** Used to keep login timing similar whether or not the email exists. */
export const DUMMY_HASH = bcrypt.hashSync('schoolverse-timing-equaliser', COST);
