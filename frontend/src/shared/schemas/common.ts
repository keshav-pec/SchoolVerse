import { z } from 'zod';

export const uuidSchema = z.uuid({ message: 'Must be a valid ID.' });

export const emailSchema = z
  .string({ message: 'Email is required.' })
  .trim()
  .toLowerCase()
  .min(1, { message: 'Email is required.' })
  .max(254, { message: 'Email is too long.' })
  .pipe(z.email({ message: 'Enter a valid email address.' }));

export const passwordSchema = z
  .string({ message: 'Password is required.' })
  .min(8, { message: 'Use at least 8 characters.' })
  .max(128, { message: 'Use at most 128 characters.' })
  .regex(/[A-Za-z]/, { message: 'Include at least one letter.' })
  .regex(/[0-9]/, { message: 'Include at least one number.' });

/** Unicode-friendly person name — no Latin-only or two-word assumptions. */
export const personNameSchema = z
  .string({ message: 'Name is required.' })
  .trim()
  .min(1, { message: 'Name is required.' })
  .max(100, { message: 'Use at most 100 characters.' });

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
