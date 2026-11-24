import { useEffect, useMemo, useState } from 'react';
import { WEEKDAY_LABELS, type BellResolutionRowDTO, type CoverageRowDTO, type EntryType, type GridDTO, type GridPeriodDTO, type Weekday } from '@shared';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Modal } from '@/components/sv/modal';
import { useSubjectOfferings } from '../../academic/api';
import { cn } from '@/lib/utils';
import { useLessonActions } from './actions';
import { useChoices } from './api';
import { useEditor } from './editor';

const ACTIVITY_TYPES: { value: EntryType; label: string }[] = [
  { value: 'ASSEMBLY', label: 'Assembly' },
  { value: 'LIBRARY', label: 'Library' },
  { value: 'SPORTS', label: 'Sports' },
  { value: 'CLUB', label: 'Club' },
  { value: 'HOMEROOM', label: 'Homeroom' },
  { value: 'OTHER', label: 'Other' },
];
const NO_ROOM = '__none';

export interface AddTarget {
  weekday: Weekday;
  period: GridPeriodDTO;
}

/**
 * Click a free cell, pick a subject, press Add. The teacher and room that fit are already chosen; change them only if you want to.
 * "Still needed" subjects come first. Assembly, Library, Sports and Club are under Add Activity.
 */
export function AddLesson({ target, grid, sectionId, classOfferingId, sections, onClose }: { target: AddTarget | null; grid: GridDTO; sectionId?: string; classOfferingId?: string; sections: BellResolutionRowDTO[]; onClose: () => void }) {
  const { versionId } = useEditor();
  const actions = useLessonActions();
  const isGroup = grid.view === 'group';
  const rows = (grid.coverage?.rows ?? []).filter((r) => (isGroup ? r.kind === 'GROUP' : r.kind === 'SECTION'));
  const needed = rows.filter((r) => r.left > 0);
  const offerings = useSubjectOfferings(isGroup ? undefined : classOfferingId);
  const others = (offerings.data ?? []).filter((o) => o.status === 'ACTIVE' && !needed.some((n) => n.subjectOfferingId === o.subjectOfferingId));

  const [tab, setTab] = useState('subject');
  const [subject, setSubject] = useState('');
  const [teacher, setTeacher] = useState('');
  const [room, setRoom] = useState('');
  const [type, setType] = useState<EntryType>('ASSEMBLY');
  const [name, setName] = useState('');
  const [wholeClass, setWholeClass] = useState(false);
  const open = target !== null;

  useEffect(() => {
    if (open) {
      setTab('subject');
      setSubject(isGroup ? (rows[0]?.subjectOfferingId ?? '') : '');
      setTeacher('');
      setRoom('');
      setName('');
      setWholeClass(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const slot = target && subject ? { versionId, weekday: target.weekday, periodId: target.period.periodId, sectionId: isGroup ? undefined : sectionId, groupId: isGroup ? grid.targetId : undefined, subjectOfferingId: subject } : null;
  const teachers = useChoices('faculty', slot);
  const rooms = useChoices('spaces', slot);
  useEffect(() => {
    if (teachers.data && !teacher) setTeacher(teachers.data.find((c) => c.ok && c.recommended)?.id ?? '');
  }, [teachers.data, teacher]);
  useEffect(() => {
    if (rooms.data && !room) setRoom(rooms.data.find((c) => c.ok && c.recommended)?.id ?? NO_ROOM);
  }, [rooms.data, room]);

  const pickList = useMemo(() => {
    const out: { value: string; label: string; hint?: string }[] = needed.map((r: CoverageRowDTO) => ({ value: r.subjectOfferingId, label: r.subjectName, hint: `${r.left} left` }));
    for (const o of others) out.push({ value: o.subjectOfferingId, label: o.subjectName, hint: 'Other' });
    return out;
  }, [needed, others]);

  const classSections = sections.filter((s) => s.classOfferingId === classOfferingId);
  const when = target ? `${WEEKDAY_LABELS[target.weekday]}, ${target.period.periodName} · ${target.period.start}–${target.period.end}` : '';

  const addSubject = async () => {
    if (!target || !subject) return;
    const base: Record<string, unknown> = { weekday: target.weekday, periodId: target.period.periodId, entryType: 'SUBJECT', subjectOfferingId: subject, ...(teacher ? { teacherIds: [teacher] } : {}), physicalSpaceId: room === NO_ROOM ? null : room || undefined };
    if (isGroup) base.teachingGroupId = grid.targetId;
    else base.sectionOfferingIds = [sectionId];
    onClose();
    await actions.add(`Add ${pickList.find((p) => p.value === subject)?.label ?? 'lesson'}`, base);
  };

  const addActivity = async () => {
    if (!target) return;
    const ids = wholeClass ? classSections.map((s) => s.sectionOfferingId) : [sectionId];
    onClose();
    await actions.add(`Add ${name || type.toLowerCase()}`, { weekday: target.weekday, periodId: target.period.periodId, entryType: type, activityName: name.trim() || ACTIVITY_TYPES.find((a) => a.value === type)?.label, sectionOfferingIds: ids });
  };

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Add a lesson" description={when}>
      <Tabs value={tab} onValueChange={setTab}>
        {!isGroup && (
          <TabsList aria-label="What to add">
            <TabsTrigger value="subject">Subject</TabsTrigger>
            <TabsTrigger value="activity">Add Activity</TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="subject" className="space-y-4">
          {needed.length > 0 && (
            <div>
              <p className="mb-1.5 text-sm font-semibold">Still needed</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Still needed">
                {needed.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={subject === r.subjectOfferingId}
                    onClick={() => {
                      setSubject(r.subjectOfferingId);
                      setTeacher('');
                      setRoom('');
                    }}
                    className={cn('rounded-pill border px-3 py-1.5 text-sm font-semibold', subject === r.subjectOfferingId ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white hover:border-brand')}
                  >
                    {r.subjectName} <span className="text-muted">· {r.left} left</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {!isGroup && (
            <div>
              <p className="mb-1.5 text-sm font-semibold">Other</p>
              <Combobox
                aria-label="Other subject"
                value={needed.some((n) => n.subjectOfferingId === subject) ? '' : subject}
                onChange={(v) => {
                  setSubject(v);
                  setTeacher('');
                  setRoom('');
                }}
                options={others.map((o) => ({ value: o.subjectOfferingId, label: o.subjectName }))}
                placeholder="Choose another subject"
                searchPlaceholder="Search subjects…"
              />
            </div>
          )}
          {subject && (
            <div className="grid gap-3 sm:grid-cols-2">
              <ComboboxField
                label="Teacher"
                value={teacher}
                onChange={setTeacher}
                options={(teachers.data ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.ok ? (c.recommended ? 'Recommended' : undefined) : (c.reason ?? 'Not free'), disabled: !c.ok }))}
                placeholder={teachers.isLoading ? 'Looking…' : 'Choose a teacher'}
                searchPlaceholder="Search teachers…"
              />
              <ComboboxField
                label="Room"
                value={room}
                onChange={setRoom}
                options={[{ value: NO_ROOM, label: 'No room' }, ...(rooms.data ?? []).map((c) => ({ value: c.id, label: c.name, hint: c.ok ? (c.detail ?? (c.recommended ? 'Recommended' : undefined)) : (c.reason ?? 'Not free'), disabled: !c.ok }))]}
                placeholder={rooms.isLoading ? 'Looking…' : 'Choose a room'}
                searchPlaceholder="Search rooms…"
              />
            </div>
          )}
          <div className="flex justify-end">
            <Button disabled={!subject} onClick={() => void addSubject()}>
              Add
            </Button>
          </div>
        </TabsContent>
        <TabsContent value="activity" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <ComboboxField label="Kind" value={type} onChange={(v) => setType(v as EntryType)} options={ACTIVITY_TYPES} searchPlaceholder="Search…" />
            <TextField label="Name" hint="Optional. Example: Morning Assembly." value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" className="size-4" checked={wholeClass} onChange={(e) => setWholeClass(e.target.checked)} />
            Every section of this class ({classSections.length})
          </label>
          <div className="flex justify-end">
            <Button onClick={() => void addActivity()}>Add Activity</Button>
          </div>
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
