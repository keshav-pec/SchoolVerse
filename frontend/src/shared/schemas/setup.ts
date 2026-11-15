import { z } from 'zod';
import { LOCATION_VALIDATION_PURPOSES, MASTER_LOCATION_SCOPES, SETUP_STEP_COUNT } from '../enums';
import { uuidSchema } from './common';

/** Wizard progress (PRD §12): which step the admin is on, so a refresh or re-login resumes there. */
export const saveSetupProgressSchema = z.object({
  currentStep: z.coerce.number().int().min(1).max(SETUP_STEP_COUNT),
});
export type SaveSetupProgressInput = z.output<typeof saveSetupProgressSchema>;

/**
 * Completing setup. When no location is Primary yet, `primaryLocationId` names the one to
 * activate (which makes it Primary automatically). Ignored when a Primary already exists.
 */
export const completeSetupSchema = z.object({
  primaryLocationId: uuidSchema.optional(),
});
export type CompleteSetupInput = z.output<typeof completeSetupSchema>;

export const masterLocationsQuerySchema = z.object({
  scope: z.enum(MASTER_LOCATION_SCOPES).default('operational'),
});
export type MasterLocationsQuery = z.output<typeof masterLocationsQuerySchema>;

export const validateLocationsSchema = z.object({
  locationIds: z.array(z.string().min(1).max(64)).min(1, { message: 'Provide at least one location ID.' }).max(100),
  purpose: z.enum(LOCATION_VALIDATION_PURPOSES, { message: 'Purpose must be NEW_ASSIGNMENT or HISTORICAL_READ.' }),
});
export type ValidateLocationsInput = z.output<typeof validateLocationsSchema>;
