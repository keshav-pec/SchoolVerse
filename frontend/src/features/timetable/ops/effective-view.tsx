import { Ban, DoorOpen, Repeat, ShieldAlert, UserRoundCheck, Sparkles } from 'lucide-react';
import { EFFECTIVE_STATE_LABELS, WEEKDAY_LABELS, type EffectiveDayDTO, type EffectiveItemDTO, type EffectiveScheduleDTO, type EffectiveState } from '@shared';
import { Badge } from '@/components/ui/badge';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * What is really on, as a list. It reads the same on a phone and on a desk: one card per period, the change (if any) marked, and what the
 * weekly timetable said beside it. Used by Views, My Timetable and the parent's Timetable, so the three always agree.
 */

const TONE: Record<EffectiveState, 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'sun' | 'lavender'> = { NORMAL: 'neutral', SUBSTITUTED: 'brand', ROOM_CHANGED: 'sun', CANCELLED: 'danger', SWAPPED: 'lavender', CHANGED: 'warning' };
const ICON: Record<EffectiveState, typeof Ban | null> = { NORMAL: null, SUBSTITUTED: UserRoundCheck, ROOM_CHANGED: DoorOpen, CANCELLED: Ban, SWAPPED: Repeat, CHANGED: Sparkles };

export const titleOf = (i: EffectiveItemDTO) => i.groupName ?? (i.entryType === 'SUBJECT' ? i.subjectName : i.activityName) ?? 'Lesson';

/** Which of the extra lines to show depends on whose week this is. */
export type Perspective = 'section' | 'teacher' | 'room' | 'student' | 'group';

export function StateBadge({ state }: { state: EffectiveState }) {
  if (state === 'NORMAL') return null;
  const Icon = ICON[state];
  return (
    <Badge tone={TONE[state]}>
      {Icon && <Icon aria-hidden="true" />} {EFFECTIVE_STATE_LABELS[state]}
    </Badge>
  );
}

export function LessonCard({ item, perspective, onClick, actions }: { item: EffectiveItemDTO; perspective: Perspective; onClick?: () => void; actions?: React.ReactNode }) {
  const cancelled = item.state === 'CANCELLED';
  const teachers = item.teachers.map((t) => t.fullName).join(', ');
  const sections = item.sections.map((s) => s.label).join(' + ');
  const lines =
    perspective === 'teacher' ? [sections || item.groupName, item.roomName] : perspective === 'room' ? [sections || item.groupName, teachers] : [teachers || null, item.roomName ? `Room: ${item.roomName}` : null];
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-semibold text-muted">
          {item.periodName} · {item.start}–{item.end}
        </span>
        <StateBadge state={item.state} />
        {item.uncovered && (
          <Badge tone="danger">
            <ShieldAlert aria-hidden="true" /> No teacher
          </Badge>
        )}
      </div>
      <p className={cn('mt-0.5 text-base font-bold text-ink', cancelled && 'line-through decoration-danger/60')}>{titleOf(item)}</p>
      {lines.filter(Boolean).map((l) => (
        <p key={String(l)} className="text-sm text-muted">
          {l}
        </p>
      ))}
      {item.note && (
        <p className={cn('mt-1 text-sm font-semibold', cancelled ? 'text-danger' : 'text-ink')} data-testid="lesson-note">
          {item.note}
        </p>
      )}
      {item.original && !cancelled && (
        <p className="mt-0.5 text-[13px] text-muted">
          Planned: {[item.original.subjectName ?? item.original.activityName, item.original.teachers.map((t) => t.fullName).join(', '), item.original.roomName, item.original.periodName !== item.periodName ? item.original.periodName : null].filter(Boolean).join(' · ')}
        </p>
      )}
    </>
  );
  return (
    <li className={cn('rounded-xl border bg-white p-3', cancelled ? 'border-danger/30 bg-danger-soft/30' : item.state !== 'NORMAL' ? 'border-brand/30' : 'border-line')} data-state={item.state}>
      {onClick ? (
        <button type="button" onClick={onClick} className="block w-full text-left">
          {body}
        </button>
      ) : (
        body
      )}
      {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}

export function FreeSlots({ day }: { day: EffectiveDayDTO }) {
  if (day.free.length === 0) return null;
  return (
    <ul aria-label="Free periods" className="flex flex-wrap gap-1.5 pt-1">
      {day.free.map((f) => (
        <li key={f.periodId} className="rounded-pill border border-dashed border-success/50 bg-success-soft/40 px-2.5 py-1 text-[13px] font-semibold text-success">
          Free · {f.periodName} {f.start}–{f.end}
        </li>
      ))}
    </ul>
  );
}

export function DaySection({ day, perspective, showFree, heading = 'full' }: { day: EffectiveDayDTO; perspective: Perspective; showFree?: boolean; heading?: 'full' | 'short' }) {
  const label = heading === 'full' ? `${WEEKDAY_LABELS[day.weekday]}, ${formatDateOnly(day.date)}` : WEEKDAY_LABELS[day.weekday];
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-sm font-extrabold tracking-wide text-ink uppercase">{label}</h3>
      {!day.isSchoolDay && <p className="rounded-xl border border-dashed border-line p-3 text-sm text-muted">Not a school day.</p>}
      {day.isSchoolDay && !day.versionId && <p className="rounded-xl border border-dashed border-line p-3 text-sm text-muted">No published timetable on this day.</p>}
      {day.isSchoolDay && day.versionId && day.items.length === 0 && <p className="rounded-xl border border-dashed border-line p-3 text-sm text-muted">Nothing is planned.</p>}
      {day.items.length > 0 && (
        <ul className="space-y-2">
          {day.items.map((i) => (
            <LessonCard key={i.entryId} item={i} perspective={perspective} />
          ))}
        </ul>
      )}
      {showFree && day.isSchoolDay && <FreeSlots day={day} />}
    </section>
  );
}

/** Several days: a stack on a phone, columns on a wide screen. */
export function WeekView({ schedule, perspective, showFree }: { schedule: EffectiveScheduleDTO; perspective: Perspective; showFree?: boolean }) {
  const days = schedule.days;
  return (
    <div className={cn('grid gap-4', days.length > 1 && 'md:grid-cols-2 xl:grid-cols-3')}>
      {days.map((d) => (
        <DaySection key={d.date} day={d} perspective={perspective} showFree={showFree} heading={days.length > 1 ? 'full' : 'full'} />
      ))}
    </div>
  );
}
