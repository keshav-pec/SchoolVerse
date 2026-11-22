import { DoorOpen, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMyClassrooms } from './allocation-api';

/**
 * "My Classroom" on a teacher's home page: where each section they teach sits. Read-only; the school office changes rooms. Shows
 * nothing at all for a teacher with no classes today.
 */
export function MyClassroomCard() {
  const q = useMyClassrooms();
  if (q.isLoading) return <Skeleton className="h-24 rounded-card" />;
  if (!q.data || (q.data.items.length === 0 && q.data.withoutRoom.length === 0)) return null;
  const { items, withoutRoom } = q.data;
  return (
    <Card className="p-4 sm:p-5" aria-label="My Classroom">
      <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
        <DoorOpen className="size-5 text-brand" aria-hidden="true" /> My Classroom
      </h2>
      <p className="mt-0.5 text-sm text-muted">Where your sections sit today. Only the school office can change a room.</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((a) => (
          <li key={a.assignmentId} className="rounded-xl border border-line px-3 py-2">
            <p className="text-sm">
              <b>{a.section.label}</b> · {a.room.spaceName}
            </p>
            <p className="text-[13px] text-muted">{a.room.path}</p>
            {a.warnings
              .filter((w) => w.code === 'BLOCK_IN_PERIOD' || w.code === 'ROOM_UNAVAILABLE')
              .map((w) => (
                <p key={w.code} className="mt-0.5 flex items-start gap-1 text-[13px] text-warning">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {w.message}
                </p>
              ))}
          </li>
        ))}
        {withoutRoom.map((s) => (
          <li key={s.sectionOfferingId} className="rounded-xl border border-dashed border-line px-3 py-2 text-sm">
            <b>{s.label}</b> <span className="text-muted">· no room yet. Ask the school office.</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
