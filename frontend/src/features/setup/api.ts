import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuditPageDTO, SchoolDTO, SetupStatusDTO } from '@shared';
import { api } from '@/lib/api';
import { schoolKeys } from '../school-profile/api';

export const setupKeys = {
  status: (schoolId: string) => ['setup-status', schoolId] as const,
  feed: ['audit', 'feed'] as const,
};

export function useSetupStatus(schoolId: string | undefined) {
  return useQuery({ queryKey: setupKeys.status(schoolId ?? ''), queryFn: () => api.get<SetupStatusDTO>(`/schools/${schoolId}/setup-status`), enabled: !!schoolId });
}

/** Recent configuration activity for the overview feed (needs `audit:view`). */
export function useRecentActivity(enabled: boolean, limit = 8) {
  return useQuery({ queryKey: [...setupKeys.feed, limit], queryFn: () => api.get<AuditPageDTO>(`/audit?limit=${limit}`), enabled });
}

/** Remembers the wizard step on the server so a refresh or re-login resumes there. Best effort. */
export function useSaveSetupProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ schoolId, step }: { schoolId: string; step: number }) => api.patch<SchoolDTO>(`/schools/${schoolId}/setup`, { currentStep: step }),
    onSuccess: (school) => qc.setQueryData(schoolKeys.current, school),
  });
}

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ schoolId, primaryLocationId }: { schoolId: string; primaryLocationId?: string }) =>
      api.post<SchoolDTO>(`/schools/${schoolId}/setup/complete`, primaryLocationId ? { primaryLocationId } : {}),
    onSuccess: (school) => {
      qc.setQueryData(schoolKeys.current, school);
      void qc.invalidateQueries({ queryKey: ['setup-status'] });
      void qc.invalidateQueries({ queryKey: ['locations'] });
      void qc.invalidateQueries({ queryKey: ['location'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
