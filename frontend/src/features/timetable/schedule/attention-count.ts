import { useActiveLocations, useSessions } from '../../academic/api';
import { usePlans } from '../api';
import { useAttention, useVersions } from './api';

const CONTEXT_KEY = 'sv.students.context';

/** The number on the sidebar badge: the same total the Needs Attention page shows, for the year and campus picked in the bar. */
export function useScheduleAttentionCount(enabled: boolean): number {
  const locations = useActiveLocations();
  const sessions = useSessions();
  let stored: { locationId?: string; sessionId?: string } = {};
  try {
    stored = JSON.parse(localStorage.getItem(CONTEXT_KEY) ?? '{}') as typeof stored;
  } catch {
    stored = {};
  }
  const active = (locations.data ?? []).filter((l) => l.status === 'ACTIVE');
  const locationId = enabled ? (active.find((l) => l.locationId === stored.locationId) ?? active.find((l) => l.isPrimary) ?? active[0])?.locationId : undefined;
  const list = sessions.data ?? [];
  const sessionId = enabled ? (list.find((s) => s.academicSessionId === stored.sessionId) ?? list.find((s) => s.isCurrent) ?? list[0])?.academicSessionId : undefined;
  const plan = usePlans(locationId, sessionId).data?.[0];
  const open = useVersions(plan?.planId).data?.find((v) => v.status === 'DRAFT' || v.status === 'READY');
  return useAttention(open?.versionId, enabled).data?.total ?? 0;
}
