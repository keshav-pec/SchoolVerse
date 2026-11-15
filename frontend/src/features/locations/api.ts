import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AuditPageDTO,
  CreateLocationInput,
  LocationAction,
  LocationCodeAvailabilityDTO,
  LocationDetailDTO,
  LocationDTO,
  LocationListDTO,
  LocationStatus,
  UpdateLocationInput,
} from '@shared';
import { api } from '@/lib/api';

export interface LocationListParams {
  q?: string;
  /** Single status filter; omitted = every status except ARCHIVED. */
  status?: LocationStatus;
  type?: string;
  city?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export const locationKeys = {
  all: ['locations'] as const,
  list: (schoolId: string, params: LocationListParams) => ['locations', schoolId, params] as const,
  detail: (locationId: string) => ['location', locationId] as const,
  audit: (entityType: string, entityId: string) => ['audit', entityType, entityId] as const,
};

function toQueryString(params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export function useLocations(schoolId: string | undefined, params: LocationListParams) {
  return useQuery({
    queryKey: locationKeys.list(schoolId ?? '', params),
    queryFn: () => api.get<LocationListDTO>(`/schools/${schoolId}/locations${toQueryString({ ...params })}`),
    enabled: !!schoolId,
    placeholderData: keepPreviousData,
  });
}

export function useLocation(locationId: string | undefined) {
  return useQuery({
    queryKey: locationKeys.detail(locationId ?? ''),
    queryFn: () => api.get<LocationDetailDTO>(`/locations/${locationId}`),
    enabled: !!locationId,
  });
}

/** Live code check + suggestion. Pass `enabled: false` for users without `location:view_config`. */
export function useCodeAvailability(schoolId: string | undefined, args: { code?: string; name?: string; excludeLocationId?: string }, enabled: boolean) {
  const code = args.code?.trim();
  const name = args.name?.trim();
  return useQuery({
    queryKey: ['code-availability', schoolId, code ?? '', name ?? '', args.excludeLocationId ?? ''],
    queryFn: () => api.get<LocationCodeAvailabilityDTO>(`/schools/${schoolId}/locations/code-availability${toQueryString({ code, name, excludeLocationId: args.excludeLocationId })}`),
    enabled: enabled && !!schoolId && Boolean(code || name),
    staleTime: 5_000,
    retry: false,
  });
}

export function useAuditTrail(entityType: string, entityId: string | undefined, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: locationKeys.audit(entityType, entityId ?? ''),
    queryFn: ({ pageParam }) => api.get<AuditPageDTO>(`/audit${toQueryString({ entityType, entityId, cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && !!entityId,
  });
}

// ───────────────────────────────────────────────────────────── optimistic cache helpers

type Snapshot = [readonly unknown[], unknown][];

/** Apply `update` to every cached list page and detail that contains the location; returns a rollback. */
function patchCaches(qc: QueryClient, update: (l: LocationDTO) => LocationDTO, onlyId?: string): () => void {
  const snapshot: Snapshot = [];
  for (const [key, data] of qc.getQueriesData<LocationListDTO>({ queryKey: locationKeys.all })) {
    if (!data) continue;
    snapshot.push([key, data]);
    qc.setQueryData<LocationListDTO>(key, { ...data, items: data.items.map((l) => (!onlyId || l.locationId === onlyId ? update(l) : l)) });
  }
  for (const [key, data] of qc.getQueriesData<LocationDetailDTO>({ queryKey: ['location'] })) {
    if (!data) continue;
    snapshot.push([key, data]);
    qc.setQueryData<LocationDetailDTO>(key, update(data) as LocationDetailDTO);
  }
  return () => snapshot.forEach(([key, data]) => qc.setQueryData(key, data));
}

function refreshAfterChange(qc: QueryClient, location?: LocationDetailDTO) {
  if (location) qc.setQueryData(locationKeys.detail(location.locationId), location);
  void qc.invalidateQueries({ queryKey: locationKeys.all });
  // Another location may have become / stopped being Primary, so refresh any other open details.
  void qc.invalidateQueries({ queryKey: ['location'] });
  void qc.invalidateQueries({ queryKey: ['audit'] });
  void qc.invalidateQueries({ queryKey: ['code-availability'] });
}

const STATUS_AFTER: Record<LocationAction, LocationStatus> = { activate: 'ACTIVE', deactivate: 'INACTIVE', archive: 'ARCHIVED' };

// ───────────────────────────────────────────────────────────── mutations

export function useCreateLocation(schoolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLocationInput) => api.post<LocationDetailDTO>(`/schools/${schoolId}/locations`, input),
    onSuccess: (location) => refreshAfterChange(qc, location),
  });
}

export function useUpdateLocation(locationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateLocationInput) => api.patch<LocationDetailDTO>(`/locations/${locationId}`, patch),
    onSuccess: (location) => refreshAfterChange(qc, location),
  });
}

/** Activate / deactivate / archive with an optimistic status change that rolls back on error. */
export function useLocationAction(locationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: LocationAction) => api.post<LocationDetailDTO>(`/locations/${locationId}/${action}`),
    onMutate: async (action) => {
      await qc.cancelQueries({ queryKey: locationKeys.all });
      await qc.cancelQueries({ queryKey: locationKeys.detail(locationId) });
      return { rollback: patchCaches(qc, (l) => ({ ...l, status: STATUS_AFTER[action] }), locationId) };
    },
    onError: (_err, _action, ctx) => ctx?.rollback(),
    onSuccess: (location) => refreshAfterChange(qc, location),
  });
}

/** Swap the Primary Location. Optimistically moves the crown and rolls back on error. */
export function useSetPrimary(defaultLocationId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (locationId?: string) => api.post<LocationDetailDTO>(`/locations/${locationId ?? defaultLocationId}/set-primary`),
    onMutate: async (locationId) => {
      const target = locationId ?? defaultLocationId;
      await qc.cancelQueries({ queryKey: locationKeys.all });
      await qc.cancelQueries({ queryKey: ['location'] });
      return { rollback: patchCaches(qc, (l) => ({ ...l, isPrimary: l.locationId === target })) };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSuccess: (location) => refreshAfterChange(qc, location),
  });
}

export function useDeleteLocation(locationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/locations/${locationId}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: locationKeys.detail(locationId) });
      refreshAfterChange(qc);
    },
  });
}
