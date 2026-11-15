import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateIdentifierInput, CreateSchoolInput, SchoolDTO, SchoolIdentifierDTO, UpdateIdentifierInput, UpdateSchoolInput } from '@shared';
import { api } from '@/lib/api';

export const schoolKeys = {
  current: ['school', 'current'] as const,
  identifiers: (schoolId: string) => ['school', schoolId, 'identifiers'] as const,
};

/** The tenant's School Master, or `null` before it has been created. */
export function useCurrentSchool() {
  return useQuery({ queryKey: schoolKeys.current, queryFn: () => api.get<SchoolDTO | null>('/schools/current'), placeholderData: keepPreviousData });
}

export function useCreateSchool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSchoolInput) => api.post<SchoolDTO>('/schools', input),
    onSuccess: (school) => qc.setQueryData(schoolKeys.current, school),
  });
}

export function useUpdateSchool(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSchoolInput) => api.patch<SchoolDTO>(`/schools/${schoolId}`, patch),
    onSuccess: (school) => {
      qc.setQueryData(schoolKeys.current, school);
      // Inherited defaults on every location depend on the school's defaults.
      void qc.invalidateQueries({ queryKey: ['locations'] });
      void qc.invalidateQueries({ queryKey: ['location'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useUploadLogo(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('logo', file);
      return api.upload<SchoolDTO>(`/schools/${schoolId}/logo`, form);
    },
    onSuccess: (school) => {
      qc.setQueryData(schoolKeys.current, school);
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useRemoveLogo(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<SchoolDTO>(`/schools/${schoolId}/logo`),
    onSuccess: (school) => {
      qc.setQueryData(schoolKeys.current, school);
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useIdentifiers(schoolId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: schoolKeys.identifiers(schoolId ?? ''),
    queryFn: () => api.get<SchoolIdentifierDTO[]>(`/schools/${schoolId}/identifiers`),
    enabled: enabled && !!schoolId,
  });
}

export function useSaveIdentifier(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ identifierId, values }: { identifierId?: string; values: CreateIdentifierInput | UpdateIdentifierInput }) =>
      identifierId ? api.patch<SchoolIdentifierDTO>(`/schools/${schoolId}/identifiers/${identifierId}`, values) : api.post<SchoolIdentifierDTO>(`/schools/${schoolId}/identifiers`, values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: schoolKeys.identifiers(schoolId) });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}

export function useDeleteIdentifier(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (identifierId: string) => api.delete<void>(`/schools/${schoolId}/identifiers/${identifierId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: schoolKeys.identifiers(schoolId) });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });
}
