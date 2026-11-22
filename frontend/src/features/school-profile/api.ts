import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateIdentifierInput, CreateSchoolInput, SchoolBrandingDTO, SchoolCodeAvailabilityDTO, SchoolDTO, SchoolIdentifierDTO, UpdateIdentifierInput, UpdateSchoolInput } from '@shared';
import { api } from '@/lib/api';

export const schoolKeys = {
  current: ['school', 'current'] as const,
  branding: ['school', 'branding'] as const,
  identifiers: (schoolId: string) => ['school', schoolId, 'identifiers'] as const,
};

/** The tenant's School Master, or `null` before it has been created. */
export function useCurrentSchool(enabled = true) {
  return useQuery({ queryKey: schoolKeys.current, queryFn: () => api.get<SchoolDTO | null>('/schools/current'), placeholderData: keepPreviousData, enabled });
}

/**
 * The school's name and logo, for the sidebar and top bar. Every signed-in role can read it (the full school profile needs
 * `school:view`, which parents and many staff don't have). Refreshed on focus so a new logo reaches other open sessions.
 */
export function useSchoolBranding() {
  return useQuery({ queryKey: schoolKeys.branding, queryFn: () => api.get<SchoolBrandingDTO>('/schools/current/branding'), staleTime: 60_000, refetchOnWindowFocus: true });
}

/** After the school's name or logo changes, the sidebar picks it up straight away. */
function setBranding(qc: ReturnType<typeof useQueryClient>, school: SchoolDTO) {
  qc.setQueryData<SchoolBrandingDTO>(schoolKeys.branding, { displayName: school.displayName, logoUrl: school.logoUrl });
}

/** Live School code check (platform-wide) + a suggestion built from the school name. Works before the school exists. */
export function fetchSchoolCodeAvailability(args: { code?: string; name?: string }) {
  const qs = new URLSearchParams();
  if (args.code) qs.set('code', args.code);
  if (args.name) qs.set('name', args.name);
  return api.get<SchoolCodeAvailabilityDTO>(`/schools/code-availability?${qs}`);
}

export function useSchoolCodeAvailability(args: { code?: string; name?: string }, enabled: boolean) {
  const code = args.code?.trim();
  const name = args.name?.trim();
  return useQuery({
    queryKey: ['school-code-availability', code ?? '', name ?? ''],
    queryFn: () => fetchSchoolCodeAvailability({ code, name }),
    enabled: enabled && Boolean(code || name),
    staleTime: 5_000,
    retry: false,
  });
}

export function useCreateSchool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSchoolInput) => api.post<SchoolDTO>('/schools', input),
    onSuccess: (school) => {
      qc.setQueryData(schoolKeys.current, school);
      setBranding(qc, school);
    },
  });
}

export function useUpdateSchool(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSchoolInput) => api.patch<SchoolDTO>(`/schools/${schoolId}`, patch),
    onSuccess: (school) => {
      qc.setQueryData(schoolKeys.current, school);
      setBranding(qc, school);
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
      setBranding(qc, school);
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
      setBranding(qc, school);
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
