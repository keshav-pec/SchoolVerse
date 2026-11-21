import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ParentChildrenDTO, ParentStudentSummaryDTO, StudentChangeRequestDTO, StudentDocumentDTO } from '@shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Parent portal reads. Nothing is cached for long: removing access must show on the next load. */
const P = ['parent'] as const;

export const useParentChildren = () =>
  useQuery({ queryKey: [...P, 'children'], queryFn: () => api.get<ParentChildrenDTO>('/parent/children'), staleTime: 0, refetchOnWindowFocus: true });

export const useParentChild = (studentId: string | undefined) =>
  useQuery({ queryKey: [...P, 'child', studentId], queryFn: () => api.get<ParentStudentSummaryDTO>(`/parent/children/${studentId}`), enabled: !!studentId, retry: false, staleTime: 0 });

export const useParentDocuments = (studentId: string | undefined) =>
  useQuery({ queryKey: [...P, 'documents', studentId], queryFn: () => api.get<StudentDocumentDTO[]>(`/parent/children/${studentId}/documents`), enabled: !!studentId, retry: false, staleTime: 0 });

export const useOwnRequests = () => useQuery({ queryKey: [...P, 'requests'], queryFn: () => api.get<StudentChangeRequestDTO[]>('/parent/change-requests') });

export function useParentMutation<V, R>(fn: (vars: V) => Promise<R>, options: { success?: string; quiet?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: P });
      if (options.success) toast.success(options.success);
    },
    onError: (error) => {
      if (!options.quiet) toast.error(messageFor(error));
    },
  });
}

/** Children this browser has shown before, so a child whose access was removed reads "no longer have access", not "not found". */
const SEEN_KEY = 'sv.parent.seen';

export function rememberChildren(ids: string[]) {
  try {
    const seen = new Set<string>(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
    for (const id of ids) seen.add(id);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Private mode: the message is just less specific.
  }
}

export function wasSeen(id: string): boolean {
  try {
    return (JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]).includes(id);
  } catch {
    return false;
  }
}
