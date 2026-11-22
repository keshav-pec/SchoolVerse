import { useMemo } from 'react';
import type { SpaceDTO } from '@shared';
import { useActiveLocations } from '../academic/api';
import { useCampusRooms } from './api';

export type AttentionFix = 'SET_CAPACITY' | 'OPEN_SPACE' | 'CHECK_FLOOR' | 'CHECK_AVAILABILITY';

export interface AttentionItem {
  key: string;
  spaceId: string;
  name: string;
  where: string;
  message: string;
  fix: AttentionFix;
}
export interface AttentionGroup {
  key: 'setup' | 'hierarchy' | 'availability';
  title: string;
  items: AttentionItem[];
}

const where = (s: SpaceDTO) => (s.building ? [s.building.buildingName, s.floor?.floorName].filter(Boolean).join(' › ') : 'Outdoor');

/**
 * Sorts a campus's rooms into the three groups Part 2 can know about. (Classroom allocation groups arrive with Classroom
 * Allocation.) Archived and inactive rooms are left out: nobody needs to fix them.
 */
export function buildAttention(rooms: readonly SpaceDTO[]): AttentionGroup[] {
  const live = rooms.filter((r) => r.status !== 'ARCHIVED');
  const item = (s: SpaceDTO, suffix: string, message: string, fix: AttentionFix): AttentionItem => ({ key: `${s.spaceId}:${suffix}`, spaceId: s.spaceId, name: s.spaceName, where: where(s), message, fix });
  const setup: AttentionItem[] = [];
  for (const s of live.filter((r) => r.status !== 'INACTIVE')) {
    for (const w of s.warnings) {
      setup.push(item(s, w.code, w.message, w.code === 'MISSING_ACADEMIC_CAPACITY' ? 'SET_CAPACITY' : 'OPEN_SPACE'));
    }
  }
  const hierarchy = live.filter((r) => r.status === 'ACTIVE' && !r.effectiveStatus.available).map((r) => item(r, 'hierarchy', r.effectiveStatus.reason ?? 'This room cannot be used right now.', 'CHECK_FLOOR'));
  const availability = live
    .filter((r) => r.status === 'TEMPORARILY_UNAVAILABLE' || r.status === 'RESTRICTED')
    .map((r) => item(r, 'availability', r.status === 'RESTRICTED' ? 'This room is restricted. Only some uses are allowed.' : 'This room is temporarily unavailable. Check the dates.', 'CHECK_AVAILABILITY'));
  return [
    { key: 'setup', title: 'Space Setup', items: setup },
    { key: 'hierarchy', title: 'Hierarchy', items: hierarchy },
    { key: 'availability', title: 'Availability', items: availability },
  ];
}

export const countAttention = (groups: readonly AttentionGroup[]) => groups.reduce((n, g) => n + g.items.length, 0);

/** Where Fix goes: the workspace with the room's inspector open. */
export const fixLink = (item: Pick<AttentionItem, 'spaceId'>) => `/spaces?room=${item.spaceId}`;

const CONTEXT_KEY = 'sv.students.context';

/**
 * The number on the sidebar badge: the same count the Needs Attention page shows, for the campus picked in the bar at the top
 * of the Campus screens (or the main campus until one is picked).
 */
export function useSpaceAttentionCount(enabled: boolean): number {
  const locations = useActiveLocations();
  let stored: string | undefined;
  try {
    stored = (JSON.parse(localStorage.getItem(CONTEXT_KEY) ?? '{}') as { locationId?: string }).locationId;
  } catch {
    stored = undefined;
  }
  const active = (locations.data ?? []).filter((l) => l.status === 'ACTIVE');
  const locationId = (active.find((l) => l.locationId === stored) ?? active.find((l) => l.isPrimary) ?? active[0])?.locationId;
  const rooms = useCampusRooms(locationId, enabled);
  return useMemo(() => (rooms.data ? countAttention(buildAttention(rooms.data.items)) : 0), [rooms.data]);
}
