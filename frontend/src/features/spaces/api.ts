import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AvailabilityBlockDTO,
  BuildingDTO,
  FloorDTO,
  SpaceChangeDTO,
  SpaceContextDTO,
  SpaceImportDTO,
  SpaceImportRowListDTO,
  SpaceListDTO,
  SpaceTreeDTO,
  SpaceTypeDTO,
} from '@shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Every room query key starts with 'spaces', so one invalidation refreshes the whole feature. */
export const SP = ['spaces'] as const;

export function qs(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

// ───────────────────────────────────────────────────────────── reads

export const useSpaceTree = (locationId: string | undefined) =>
  useQuery({ queryKey: [...SP, 'tree', locationId], queryFn: () => api.get<SpaceTreeDTO>(`/locations/${locationId}/space-tree`), enabled: !!locationId });

export interface SpaceListParams {
  locationId?: string;
  buildingId?: string;
  floorId?: string;
  outdoor?: boolean;
  q?: string;
  spaceTypeId?: string;
  /** Comma separated statuses. */
  status?: string;
  schedulable?: boolean;
  missingCapacity?: boolean;
  page?: number;
  pageSize?: number;
}

export const useSpaces = (params: SpaceListParams, enabled = true) =>
  useQuery({
    queryKey: [...SP, 'list', params],
    queryFn: () => api.get<SpaceListDTO>(`/physical-spaces${qs({ ...params })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

/** The room as other modules see it, plus its blocks. */
export const useSpace = (spaceId: string | undefined) =>
  useQuery({ queryKey: [...SP, 'space', spaceId], queryFn: () => api.get<SpaceContextDTO>(`/physical-spaces/${spaceId}`), enabled: !!spaceId, retry: false });

export const useSpaceTypes = () => useQuery({ queryKey: [...SP, 'types'], queryFn: () => api.get<SpaceTypeDTO[]>('/space-types'), staleTime: 30_000 });

export const useBuildings = (locationId: string | undefined) =>
  useQuery({ queryKey: [...SP, 'buildings', locationId], queryFn: () => api.get<BuildingDTO[]>(`/locations/${locationId}/buildings`), enabled: !!locationId });

export const useFloors = (buildingId: string | undefined) =>
  useQuery({ queryKey: [...SP, 'floors', buildingId], queryFn: () => api.get<FloorDTO[]>(`/buildings/${buildingId}/floors`), enabled: !!buildingId });

export const useBlocks = (spaceId: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...SP, 'blocks', spaceId], queryFn: () => api.get<AvailabilityBlockDTO[]>(`/physical-spaces/${spaceId}/availability-blocks`), enabled: !!spaceId && enabled });

export const useSpaceHistory = (spaceId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: [...SP, 'history', spaceId], queryFn: () => api.get<SpaceChangeDTO[]>(`/physical-spaces/${spaceId}/history`), enabled: !!spaceId && enabled });

export const useSpaceImports = () => useQuery({ queryKey: [...SP, 'imports'], queryFn: () => api.get<SpaceImportDTO[]>('/space-imports') });

export const useSpaceImport = (importId: string | undefined) =>
  useQuery({ queryKey: [...SP, 'import', importId], queryFn: () => api.get<SpaceImportDTO>(`/space-imports/${importId}`), enabled: !!importId, retry: false });

export const useSpaceImportRows = (importId: string | undefined, params: { status?: string; page?: number }, enabled = true) =>
  useQuery({
    queryKey: [...SP, 'import-rows', importId, params],
    queryFn: () => api.get<SpaceImportRowListDTO>(`/space-imports/${importId}/rows${qs({ pageSize: 25, ...params })}`),
    enabled: !!importId && enabled,
    placeholderData: keepPreviousData,
  });

export const SPACE_IMPORT_TEMPLATE_URL = '/api/v1/space-imports/template.csv';

/** The room table as a CSV file (same filters as the table). */
export function exportUrl(params: SpaceListParams): string {
  const { page: _page, pageSize: _pageSize, ...rest } = params;
  return `/api/v1/physical-spaces/export${qs({ ...rest })}`;
}

/**
 * Everything the Needs Attention screen and its sidebar badge are built from: one load of the campus's rooms, sorted
 * into groups on the screen. (Allocation groups arrive with Classroom Allocation.)
 */
export const useCampusRooms = (locationId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...SP, 'attention-rooms', locationId],
    queryFn: () => api.get<SpaceListDTO>(`/physical-spaces${qs({ locationId, status: 'DRAFT,ACTIVE,TEMPORARILY_UNAVAILABLE,RESTRICTED,INACTIVE', pageSize: 200 })}`),
    enabled: !!locationId && enabled,
    staleTime: 60_000,
  });

// ───────────────────────────────────────────────────────────── writes

interface MutationOptions<V, R> {
  success?: string | ((result: R, vars: V) => string);
  /** The screen shows the error itself (inside a dialog). */
  quiet?: boolean;
}

/** Runs a write, refreshes everything under 'spaces' and the audit trails, and toasts the outcome. */
export function useSpaceMutation<V, R>(fn: (vars: V) => Promise<R>, options: MutationOptions<V, R> = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: SP });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      if (options.success) toast.success(typeof options.success === 'function' ? options.success(result, vars) : options.success);
    },
    onError: (error) => {
      if (!options.quiet) toast.error(messageFor(error));
    },
  });
}
