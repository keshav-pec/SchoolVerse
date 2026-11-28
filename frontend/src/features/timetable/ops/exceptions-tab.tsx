import { useState } from 'react';
import { Ban, DoorClosed, UserRoundX } from 'lucide-react';
import type { DailyScheduleDTO } from '@shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { useTimetableMutation } from '../api';
import { ops, useOverrides } from './api';
import { OneDayDialog, type DayLesson } from './change-dialog';
import { lessonOf } from './cancel-tab';
import { LessonCard } from './effective-view';

const ICON = { ABSENT: UserRoundX, ROOM: DoorClosed, CANCELLED: Ban } as const;

/** Today's Exceptions: what is wrong right now, the periods with no teacher, and the changes already made for the day. */
export function ExceptionsTab({ planId, locationId, day, date, onGo }: { planId: string; locationId: string; day: DailyScheduleDTO; date: string; onGo: (tab: 'substitutions' | 'rooms' | 'cancel') => void }) {
  const overrides = useOverrides(planId, date);
  const [fix, setFix] = useState<DayLesson | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const undo = useTimetableMutation((id: string) => ops.cancelOverride(id), { success: 'Change cancelled. The lesson is back as planned.' });
  const live = day.lessons.filter((l) => l.state !== 'CANCELLED').map(lessonOf);

  return (
    <div className="space-y-4">
      {day.message && <p className="rounded-xl border border-dashed border-line bg-white p-4 text-sm text-muted">{day.message}</p>}
      {day.exceptions.length === 0 && !day.message && <Card className="p-4 text-sm text-muted">No problems today. When a teacher is away or a room is closed, it shows here.</Card>}
      <div className="grid gap-3 md:grid-cols-2">
        {day.exceptions.map((e) => {
          const Icon = ICON[e.kind];
          return (
            <Card key={`${e.kind}-${e.employeeId ?? e.physicalSpaceId ?? 'x'}`} className="flex items-start justify-between gap-3 p-4" aria-label={e.title}>
              <div className="flex gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
                <div>
                  <p className="font-bold">{e.title}</p>
                  <p className="text-sm text-muted">{e.message}</p>
                </div>
              </div>
              {e.uncovered > 0 && (
                <Button variant="outline" size="sm" onClick={() => onGo(e.kind === 'ROOM' ? 'rooms' : 'substitutions')}>
                  {e.kind === 'ROOM' ? 'Move Lessons' : 'Find Teachers'}
                </Button>
              )}
            </Card>
          );
        })}
      </div>

      {day.uncovered.length > 0 && (
        <section aria-label="Periods with no teacher" className="space-y-2">
          <h2 className="text-lg font-bold">Periods With No Teacher ({day.uncovered.length})</h2>
          <ul className="space-y-2">
            {day.uncovered.map((i) => (
              <LessonCard key={i.entryId} item={i} perspective="section" actions={<Button size="sm" onClick={() => setFix(lessonOf(i))}>Find A Teacher</Button>} />
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Changes for the day" className="space-y-2">
        <h2 className="text-lg font-bold">Changes For This Day</h2>
        {overrides.data?.length === 0 && <p className="text-sm text-muted">No changes yet.</p>}
        <ul className="space-y-2">
          {overrides.data?.map((o) => (
            <li key={o.overrideId} className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="font-semibold">
                  {o.label} <span className="font-normal text-muted">· {o.when}</span>
                </p>
                <p className="text-[13px] text-muted">
                  <Badge tone="brand">{o.type === 'SUBSTITUTE_FACULTY' ? 'Substitute' : o.type === 'ROOM_CHANGE' ? 'Room' : o.type === 'CLASS_CANCELLED' ? 'Cancelled' : o.type === 'PERIOD_SWAP' ? 'Swap' : 'Changed'}</Badge> {o.summary.replace(/^[^:]+: /, '')}
                  {o.reason ? ` · ${o.reason}` : ''}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setUndoing(o.overrideId)}>
                Cancel Change
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-[13px] text-muted">The weekly timetable is not changed.</p>
      </section>
      {fix && <OneDayDialog planId={planId} locationId={locationId} lesson={fix} dayLessons={live} initial="SUBSTITUTE_FACULTY" open onClose={() => setFix(null)} />}
      <ConfirmDialog
        open={!!undoing}
        onOpenChange={(o) => !o && setUndoing(null)}
        title="Cancel this change?"
        description="The lesson goes back to what the weekly timetable says."
        confirmLabel="Cancel Change"
        loadingLabel="Cancelling…"
        onConfirm={async () => {
          if (undoing) await undo.mutateAsync(undoing);
        }}
      />
    </div>
  );
}
