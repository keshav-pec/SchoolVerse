import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, DoorClosed, Lock, MoveRight, Trash2, UserRound, Wand2, X } from 'lucide-react';
import { WEEKDAY_LABELS, ENTRY_TYPE_LABELS, RULE_LABELS, type GridCellDTO, type GridDTO } from '@shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { useAuth } from '@/lib/auth';
import { TIPS } from '../help-copy';
import { lessonName, useLessonActions } from './actions';
import { FIXABLE_RULES, FixThisForMe, MoveTo } from './dialogs';
import { useEditor } from './editor';
import { ChoicePicker } from './pickers';

/** What one lesson is, and the few things to change about it. There is no separate edit page. */
export function Inspector({ cell, grid, onClose, focus }: { cell: GridCellDTO; grid: GridDTO; onClose: () => void; focus?: 'teacher' | 'room' | 'move' | null }) {
  const { can } = useAuth();
  const { versionId } = useEditor();
  const actions = useLessonActions();
  const [picker, setPicker] = useState<'faculty' | 'spaces' | null>(null);
  const [moving, setMoving] = useState(false);
  const [more, setMore] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [fix, setFix] = useState<(typeof cell.issueList)[number] | null>(null);
  const [notes, setNotes] = useState(cell.notes ?? '');
  const editable = grid.status === 'DRAFT' || grid.status === 'READY';
  const canEdit = editable && can('timetable:entry:edit');
  useEffect(() => setNotes(cell.notes ?? ''), [cell.entryId, cell.notes, cell.version]);
  useEffect(() => {
    if (focus === 'teacher') setPicker('faculty');
    if (focus === 'room') setPicker('spaces');
    if (focus === 'move') setMoving(true);
  }, [focus, cell.entryId]);

  const target = { versionId, weekday: cell.weekday, periodId: cell.periodId, sectionId: cell.sections[0]?.sectionOfferingId, groupId: cell.teachingGroupId ?? undefined, subjectOfferingId: cell.subjectOfferingId ?? undefined, excludeEntryId: cell.entryId };
  const teachers = cell.teachers.map((t) => t.fullName).join(', ');
  const issues = cell.issueList.filter((i) => i.severity !== 'INFO');

  return (
    <Card className="space-y-3 p-4" aria-label="Lesson details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold">{lessonName(cell)}</h2>
          <p className="text-[13px] text-muted">
            {cell.sections.map((s) => s.label).join(' + ') || cell.groupName || ENTRY_TYPE_LABELS[cell.entryType]}
            {cell.isFixed && (
              <Badge tone="neutral" className="ml-2">
                <Lock /> Fixed
              </Badge>
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close details">
          <X />
        </Button>
      </div>

      <dl className="space-y-2 text-sm">
        <Line icon={<UserRound className="size-4" />} label="Teacher">
          {canEdit ? (
            <Button variant="outline" size="sm" onClick={() => setPicker('faculty')} aria-label={`Teacher: ${teachers || 'none'}. Change`}>
              {teachers || 'Pick a teacher'}
            </Button>
          ) : (
            teachers || 'None'
          )}
        </Line>
        <Line icon={<DoorClosed className="size-4" />} label="Room">
          {canEdit ? (
            <Button variant="outline" size="sm" onClick={() => setPicker('spaces')} aria-label={`Room: ${cell.roomName ?? 'none'}. Change`}>
              {cell.roomName ?? 'Pick a room'}
            </Button>
          ) : (
            (cell.roomName ?? 'None')
          )}
        </Line>
        <Line icon={<MoveRight className="size-4" />} label="Time">
          <span>
            {WEEKDAY_LABELS[cell.weekday]}, {cell.periodName} · {cell.start}–{cell.end}
          </span>
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setMoving(true)}>
              Move To…
            </Button>
          )}
        </Line>
      </dl>

      {issues.length > 0 && (
        <ul className="space-y-1.5" aria-label="Problems with this lesson">
          {issues.map((i, n) => (
            <li key={`${i.rule}-${n}`} className="rounded-lg border border-warning/40 bg-warning-soft/60 px-3 py-2 text-[13px]">
              <span className="font-semibold">{RULE_LABELS[i.rule]}.</span> {i.message}
              {i.overriddenReason && <span className="block text-muted">Allowed: {i.overriddenReason}</span>}
              {canEdit && FIXABLE_RULES.includes(i.rule) && (
                <Button variant="link" size="sm" className="ml-1 h-auto" onClick={() => setFix(i)}>
                  <Wand2 /> Fix This For Me
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="flex items-center gap-1 text-sm font-semibold text-brand" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {more ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />} More
      </button>
      {more && (
        <div className="space-y-3 text-sm">
          {cell.teachers.length > 1 && <p>Co-teachers: {cell.teachers.slice(1).map((t) => t.fullName).join(', ')}</p>}
          {cell.sections.length > 1 && <p>Sections together: {cell.sections.map((s) => s.label).join(', ')}</p>}
          <p className="text-muted">Added by: {cell.source === 'SMART_DRAFT' ? 'Smart Draft' : cell.source === 'PREVIOUS_SESSION_COPY' ? "Last year's timetable" : cell.source === 'BULK' ? 'A bulk change' : 'A person'} · Change {cell.version}</p>
          <label className="flex items-center gap-2 font-semibold">
            <input type="checkbox" className="size-4" checked={cell.isFixed} disabled={!canEdit} onChange={(e) => void actions.setFixed(cell, e.target.checked)} />
            Fixed period
            <InfoTip label="About fixed periods">{TIPS.fixedPeriod}</InfoTip>
          </label>
          <label className="block">
            <span className="mb-1 block font-semibold">Note</span>
            <Textarea rows={2} value={notes} disabled={!canEdit} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (cell.notes ?? '') && void actions.setNotes(cell, notes)} />
          </label>
        </div>
      )}

      {can('timetable:entry:delete') && editable && (
        <Button variant="outline" size="sm" className="text-danger" onClick={() => setRemoving(true)}>
          <Trash2 /> Remove Lesson
        </Button>
      )}

      <ChoicePicker
        kind="faculty"
        target={target}
        open={picker === 'faculty'}
        onClose={() => setPicker(null)}
        currentId={cell.teachers[0]?.employeeId}
        onPick={(id) => {
          setPicker(null);
          if (id) void actions.setTeacher(cell, id);
        }}
      />
      <ChoicePicker
        kind="spaces"
        target={target}
        open={picker === 'spaces'}
        onClose={() => setPicker(null)}
        currentId={cell.physicalSpaceId}
        allowNone
        onPick={(id) => {
          setPicker(null);
          void actions.setRoom(cell, id);
        }}
      />
      <MoveTo cell={cell} grid={grid} open={moving} onClose={() => setMoving(false)} />
      {fix && <FixThisForMe entryId={cell.entryId} rule={fix.rule} open onClose={() => setFix(null)} />}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove this lesson?"
        description={`${lessonName(cell)} on ${WEEKDAY_LABELS[cell.weekday]}, ${cell.periodName} will be removed. You can undo it right after.`}
        confirmLabel="Remove Lesson"
        loadingLabel="Removing…"
        tone="danger"
        onConfirm={async () => {
          await actions.remove(cell);
          onClose();
        }}
      />
    </Card>
  );
}

function Line({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="flex w-24 items-center gap-1.5 font-semibold text-muted">
        {icon}
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</dd>
    </div>
  );
}
