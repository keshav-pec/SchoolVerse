import type { SchoolFormValues } from '@/features/school-profile/school-fields';

/**
 * Steps 1–2 live in this browser until the school is created at the end of step 2.
 * (Nothing exists on the server yet, so there is nothing else to resume from.)
 */
export interface WizardDraft {
  step: number;
  values: Partial<SchoolFormValues>;
}

const key = (tenantId: string) => `sv.setup.draft.${tenantId}`;

export function readDraft(tenantId: string): WizardDraft | null {
  try {
    const raw = localStorage.getItem(key(tenantId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WizardDraft;
    return { step: Math.min(Math.max(Number(parsed.step) || 1, 1), 2), values: parsed.values ?? {} };
  } catch {
    return null;
  }
}

export function writeDraft(tenantId: string, draft: WizardDraft) {
  try {
    localStorage.setItem(key(tenantId), JSON.stringify(draft));
  } catch {
    // Private mode / quota: the wizard still works, it just can't resume.
  }
}

export function clearDraft(tenantId: string) {
  try {
    localStorage.removeItem(key(tenantId));
  } catch {
    // ignore
  }
}
