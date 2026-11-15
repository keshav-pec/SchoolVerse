import { z } from 'zod';
import { emailSchema, passwordSchema, personNameSchema } from './common';

export const signupSchema = z.object({
  workspaceName: z
    .string({ message: 'School or workspace name is required.' })
    .trim()
    .min(2, { message: 'Use at least 2 characters.' })
    .max(120, { message: 'Use at most 120 characters.' }),
  fullName: personNameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ message: 'Password is required.' }).min(1, { message: 'Password is required.' }).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;
