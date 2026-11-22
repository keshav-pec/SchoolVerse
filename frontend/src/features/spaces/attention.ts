import type { SpaceAttentionRowDTO } from '@shared';
import { useActiveLocations, useSessions } from '../academic/api';
import { useSpaceAttention } from './allocation-api';

/**
 * Where each Fix goes. A section without a room opens Classroom Allocation with that section's room picker; a room problem opens the
 * room's panel in Space Setup (seats, closures and the floor are all there). "Choose Larger Room" is handled on the page itself.
 */
export function fixLink(row: Pick<SpaceAttentionRowDTO, 'fix' | 'sectionOfferingId' | 'physicalSpaceId'>): string | null {
  if (row.fix === 'ASSIGN_ROOM' && row.sectionOfferingId) return `/spaces/allocation?section=${row.sectionOfferingId}`;
  if (row.fix === 'CHOOSE_LARGER_ROOM') return null;
  return row.physicalSpaceId ? `/spaces?room=${row.physicalSpaceId}` : null;
}

const CONTEXT_KEY = 'sv.students.context';

/**
 * The number on the sidebar badge: the same total the Needs Attention page shows, for the year and campus picked in the bar at the
 * top of the Campus screens (or the current year and main campus until one is picked).
 */
export function useSpaceAttentionCount(enabled: boolean): number {
  const locations = useActiveLocations();
  const sessions = useSessions();
  let stored: { locationId?: string; sessionId?: string } = {};
  try {
    stored = JSON.parse(localStorage.getItem(CONTEXT_KEY) ?? '{}') as typeof stored;
  } catch {
    stored = {};
  }
  const active = (locations.data ?? []).filter((l) => l.status === 'ACTIVE');
  const locationId = (active.find((l) => l.locationId === stored.locationId) ?? active.find((l) => l.isPrimary) ?? active[0])?.locationId;
  const list = sessions.data ?? [];
  const sessionId = (list.find((s) => s.academicSessionId === stored.sessionId) ?? list.find((s) => s.isCurrent) ?? list[0])?.academicSessionId;
  const q = useSpaceAttention(locationId, sessionId, enabled && !!locationId && !sessions.isLoading);
  return q.data?.counts.needsAttention ?? 0;
}
