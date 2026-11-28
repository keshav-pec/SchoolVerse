import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AlternativeDTO, OverrideType, TimetableIssueDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { Modal } from '@/components/sv/modal';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { useCampusRooms } from '../../spaces/api';
import { TT, useBellResolution, usePlanTeachers, useRequirements } from '../api';
import { ops, useRoomRecommendations, useSubstituteRecommendations } from './api';

/** A lesson on a date, as the one-day screens know it. */
export interface DayLesson {
  entryId: string;
  date: string;
  label: string;
  when: string;
  sectionId?: string;
  start?: number;
  end?: number;
}

const TYPES: { id: OverrideType; label: string }[] = [
  { id: 'SUBSTITUTE_FACULTY', label: 'Another teacher takes it' },
  { id: 'ROOM_CHANGE', label: 'Move it to another room' },
  { id: 'CLASS_CANCELLED', label: 'Cancel it' },
  { id: 'SPECIAL_ACTIVITY', label: 'Special activity instead' },
  { id: 'SUBJECT_CHANGE', label: 'Another subject instead' },
  { id: 'COMBINED_CLASS', label: 'Join another lesson' },
];

export interface ClashState {
  message: string;
  blockers: TimetableIssueDTO[];
  alternatives: AlternativeDTO[];
}

/** Reads a refused one-day change: the reasons, and the better options the server found. */
export function clashOf(err: unknown): ClashState | null {
  if (!(err instanceof ApiError) || err.code !== 'TIMETABLE_CLASH') return null;
  const d = (err.details ?? {}) as { blockers?: TimetableIssueDTO[]; alternatives?: AlternativeDTO[] };
  return { message: err.message, blockers: d.blockers ?? [], alternatives: d.alternatives ?? [] };
}

/** "Why not?": what is in the way, with the options as buttons. */
export function ClashNote({ clash, onPick }: { clash: ClashState; onPick?: (alt: AlternativeDTO) => void }) {
  return (
    <Alert tone="danger" title="This cannot be saved">
      <ul className="list-disc space-y-0.5 pl-4">
        {(clash.blockers.length > 0 ? clash.blockers.map((b) => b.message) : [clash.message]).map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
      {clash.alternatives.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-[13px] font-semibold text-ink">Better options</p>
          <div className="flex flex-wrap gap-2">
            {clash.alternatives.map((a) => (
              <Button key={a.label} type="button" size="sm" variant="outline" onClick={() => onPick?.(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </Alert>
  );
}

/**
 * One lesson, one day. Pick what happens (another teacher, another room, cancelled…), see the suggestions that are already checked, and
 * save. A clash shows the reasons and options and saves nothing. The weekly timetable is never changed.
 */
export function OneDayDialog({ planId, locationId, lesson, dayLessons, initial = 'SUBSTITUTE_FACULTY', onlyType = false, open, onClose }: { planId: string; locationId: string; lesson: DayLesson; dayLessons: DayLesson[]; initial?: OverrideType; onlyType?: boolean; open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [type, setType] = useState<OverrideType>(initial);
  const [teacher, setTeacher] = useState('');
  const [room, setRoom] = useState('');
  const [subject, setSubject] = useState('');
  const [activity, setActivity] = useState('');
  const [other, setOther] = useState('');
  const [reason, setReason] = useState('');
  const [allowReason, setAllowReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [clash, setClash] = useState<ClashState | null>(null);
  useEffect(() => {
    if (open) {
      setType(initial);
      setTeacher('');
      setRoom('');
      setSubject('');
      setActivity('');
      setOther('');
      setReason('');
      setAllowReason('');
      setClash(null);
    }
  }, [open, initial, lesson.entryId, lesson.date]);

  const items = useMemo(() => [{ entryId: lesson.entryId, date: lesson.date }], [lesson.entryId, lesson.date]);
  const teachers = usePlanTeachers(open ? planId : undefined);
  const rooms = useCampusRooms(locationId, open && type === 'ROOM_CHANGE');
  const suggestedTeachers = useSubstituteRecommendations(open && type === 'SUBSTITUTE_FACULTY' ? planId : undefined, items);
  const suggestedRooms = useRoomRecommendations(open && type === 'ROOM_CHANGE' ? planId : undefined, items);
  const resolution = useBellResolution(open && type === 'SUBJECT_CHANGE' ? planId : undefined);
  const classId = resolution.data?.rows.find((r) => r.sectionOfferingId === lesson.sectionId)?.classOfferingId;
  const needs = useRequirements(open && type === 'SUBJECT_CHANGE' ? planId : undefined, classId);

  const picks = type === 'SUBSTITUTE_FACULTY' ? [suggestedTeachers.data?.[0]?.recommended, ...(suggestedTeachers.data?.[0]?.alternatives ?? [])].filter((x) => !!x) : [];
  const roomPicks = type === 'ROOM_CHANGE' ? [suggestedRooms.data?.[0]?.recommended, ...(suggestedRooms.data?.[0]?.alternatives ?? [])].filter((x) => !!x) : [];
  const overridable = clash?.blockers.length === 1 && clash.blockers[0]!.overridable && can('timetable:conflict:override');

  const body = (override?: { rule: string; reason: string }): Record<string, unknown> => ({
    type,
    entryId: lesson.entryId,
    date: lesson.date,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
    ...(type === 'SUBSTITUTE_FACULTY' ? { substituteEmployeeId: teacher } : {}),
    ...(type === 'ROOM_CHANGE' ? { physicalSpaceId: room || null } : {}),
    ...(type === 'SPECIAL_ACTIVITY' ? { activityName: activity.trim() } : {}),
    ...(type === 'SUBJECT_CHANGE' ? { subjectOfferingId: subject } : {}),
    ...(type === 'COMBINED_CLASS' ? { withEntryId: other } : {}),
    ...(override ? { override } : {}),
  });
  const ready = type === 'SUBSTITUTE_FACULTY' ? !!teacher : type === 'ROOM_CHANGE' ? !!room : type === 'CLASS_CANCELLED' ? reason.trim().length > 0 : type === 'SPECIAL_ACTIVITY' ? activity.trim().length > 0 : type === 'SUBJECT_CHANGE' ? !!subject : type === 'COMBINED_CLASS' ? !!other : false;

  const save = async (override?: { rule: string; reason: string }) => {
    setBusy(true);
    setClash(null);
    try {
      const r = await ops.createOverride(body(override));
      toast.success(r.override.summary);
      await qc.invalidateQueries({ queryKey: TT });
      onClose();
    } catch (err) {
      const c = clashOf(err);
      if (c) setClash(c);
      else toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  };
  const take = (a: AlternativeDTO) => {
    setClash(null);
    if (a.kind === 'TEACHER' && a.employeeId) {
      setType('SUBSTITUTE_FACULTY');
      setTeacher(a.employeeId);
    }
    if (a.kind === 'ROOM' && a.physicalSpaceId) {
      setType('ROOM_CHANGE');
      setRoom(a.physicalSpaceId);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={onlyType ? TYPES.find((t) => t.id === initial)!.label : 'Change This Lesson For One Day'}
      description={`${lesson.label} · ${lesson.when} · ${lesson.date}. The weekly timetable is not changed.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!ready} loading={busy} loadingText="Saving…" onClick={() => void save()}>
            {type === 'CLASS_CANCELLED' ? 'Cancel Lesson' : 'Save Change'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!onlyType && <ComboboxField label="What happens" value={type} onChange={(v) => setType(v as OverrideType)} options={TYPES.map((t) => ({ value: t.id, label: t.label }))} searchPlaceholder="Search…" />}
        {type === 'SUBSTITUTE_FACULTY' && (
          <>
            {picks.length > 0 && (
              <div className="space-y-1" aria-label="Suggested teachers">
                <p className="text-[13px] font-semibold">Suggested (already checked)</p>
                {picks.map((p) => (
                  <button key={p!.employeeId} type="button" onClick={() => setTeacher(p!.employeeId)} className="block w-full rounded-xl border border-line p-2 text-left text-sm hover:border-brand/40">
                    <b>{p!.fullName}</b>
                    <span className="block text-[13px] text-muted">{p!.why}</span>
                  </button>
                ))}
              </div>
            )}
            {suggestedTeachers.data?.[0]?.message && <Alert tone="warning">{suggestedTeachers.data[0].message}</Alert>}
            <ComboboxField label="Teacher" value={teacher} onChange={setTeacher} options={(teachers.data ?? []).map((t) => ({ value: t.employeeId, label: t.fullName, hint: t.employeeCode }))} placeholder="Choose…" searchPlaceholder="Search teachers…" />
          </>
        )}
        {type === 'ROOM_CHANGE' && (
          <>
            {roomPicks.length > 0 && (
              <div className="space-y-1" aria-label="Suggested rooms">
                <p className="text-[13px] font-semibold">Suggested (already checked)</p>
                {roomPicks.map((p) => (
                  <button key={p!.physicalSpaceId} type="button" onClick={() => setRoom(p!.physicalSpaceId)} className="block w-full rounded-xl border border-line p-2 text-left text-sm hover:border-brand/40">
                    <b>{p!.name}</b>
                    <span className="block text-[13px] text-muted">{p!.why}</span>
                  </button>
                ))}
              </div>
            )}
            <ComboboxField label="Room" value={room} onChange={setRoom} options={(rooms.data?.items ?? []).map((r) => ({ value: r.spaceId, label: r.spaceName }))} placeholder="Choose…" searchPlaceholder="Search rooms…" />
          </>
        )}
        {type === 'SPECIAL_ACTIVITY' && <TextField label="Activity" value={activity} onChange={(e) => setActivity(e.target.value)} hint="Example: Quiz Hour, Sports Practice." />}
        {type === 'SUBJECT_CHANGE' && (
          <ComboboxField label="Subject" value={subject} onChange={setSubject} options={(needs.data?.items ?? []).map((i) => ({ value: i.subjectOfferingId, label: i.subjectName }))} placeholder="Choose…" searchPlaceholder="Search subjects…" />
        )}
        {type === 'COMBINED_CLASS' && (
          <ComboboxField
            label="Join this lesson"
            value={other}
            onChange={setOther}
            options={dayLessons.filter((l) => l.entryId !== lesson.entryId && (lesson.start === undefined || l.start === undefined || (l.start < (lesson.end ?? 0) && lesson.start < (l.end ?? 0)))).map((l) => ({ value: l.entryId, label: l.label, hint: l.when }))}
            placeholder="Choose…"
            searchPlaceholder="Search lessons…"
            hint="Only lessons at the same time are listed."
          />
        )}
        <TextareaField label={type === 'CLASS_CANCELLED' ? 'Reason' : 'Reason (optional)'} required={type === 'CLASS_CANCELLED'} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        {clash && <ClashNote clash={clash} onPick={take} />}
        {overridable && clash && (
          <div className="space-y-2 rounded-xl border border-line p-3">
            <TextField label="Allow it anyway: why?" value={allowReason} onChange={(e) => setAllowReason(e.target.value)} hint="Only people with permission can do this. The reason is written down." />
            <Button type="button" variant="outline" size="sm" disabled={!allowReason.trim() || busy} onClick={() => void save({ rule: clash.blockers[0]!.rule, reason: allowReason.trim() })}>
              Allow Anyway
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
