import { useState } from 'react';
import { Plus, Search, UserMinus, UserPlus } from 'lucide-react';
import { TEACHING_GROUP_KINDS, type GroupHealthStudentDTO, type PlanTeacherDTO, type TeachingGroupDTO, type TeachingGroupKind, type TimetablePlanDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { useClassOfferings, useSections, useSubjectOfferings } from '../../academic/api';
import { useStudents } from '../../students/api';
import { useStudentContext } from '../../students/context';
import { useGroupHealth, useGroupMembers, useGroups, usePlanTeachers, useTimetableMutation } from '../api';
import { GROUPS_INTRO, TIPS } from '../help-copy';

const KIND_LABELS: Record<TeachingGroupKind, string> = { SUBJECT: 'Subject', LANGUAGE: 'Language', ACTIVITY: 'Activity' };

// ───────────────────────────────────────────────────────────── add a group

function AddGroup({ plan, teachers, onClose }: { plan: TimetablePlanDTO; teachers: PlanTeacherDTO[]; onClose: () => void }) {
  const ctx = useStudentContext();
  const classes = useClassOfferings(ctx.sessionId, ctx.locationId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TeachingGroupKind>('SUBJECT');
  const [classId, setClassId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [pool, setPool] = useState<string[]>([]);
  const [teacher, setTeacher] = useState('');
  const subjects = useSubjectOfferings(classId || undefined);
  const sections = useSections(classId || undefined);
  const activity = kind === 'ACTIVITY';
  const create = useTimetableMutation(
    () => api.post<TeachingGroupDTO>('/teaching-groups', { planId: plan.planId, name: name.trim(), kind, ...(classId ? { classOfferingId: classId } : {}), ...(!activity && subjectId ? { subjectOfferingId: subjectId } : {}), sectionPool: pool, ...(teacher ? { teacherIds: [teacher] } : {}) }),
    { success: 'Teaching Group added.' },
  );
  const ready = name.trim() && (activity || (classId && subjectId && pool.length > 0));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add Teaching Group"
      description="Example: French for 8-A, 8-B and 8-C."
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} loading={create.isPending} loadingText="Adding…" onClick={async () => void (await create.mutateAsync(undefined).then(onClose, () => undefined))}>
            Add Group
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Group name" value={name} onChange={(e) => setName(e.target.value)} placeholder="French – Class 8" required />
        <ComboboxField label="Kind" value={kind} onChange={(v) => setKind(v as TeachingGroupKind)} options={TEACHING_GROUP_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} searchPlaceholder="Search kinds…" />
        <ComboboxField label="Class" value={classId} onChange={(v) => { setClassId(v); setSubjectId(''); setPool([]); }} options={(classes.data ?? []).map((c) => ({ value: c.classOfferingId, label: c.displayName }))} placeholder="Choose class" searchPlaceholder="Search classes…" required={!activity} />
        {!activity && <ComboboxField label="Subject" value={subjectId} onChange={setSubjectId} options={(subjects.data ?? []).map((s) => ({ value: s.subjectOfferingId, label: s.subjectName, hint: s.offeringType === 'MANDATORY' ? 'Everyone' : 'Choice' }))} placeholder={classId ? 'Choose subject' : 'Choose a class first'} searchPlaceholder="Search subjects…" disabled={!classId} required />}
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Students come from these sections</legend>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={!classId} onClick={() => setPool((sections.data ?? []).map((s) => s.sectionOfferingId))}>
              Select All
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPool([])}>
              Clear
            </Button>
          </div>
          {!classId && <p className="text-sm text-muted">Choose a class to see its sections.</p>}
          <ul className="grid gap-1 sm:grid-cols-3">
            {(sections.data ?? []).map((s) => (
              <li key={s.sectionOfferingId}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-brand" checked={pool.includes(s.sectionOfferingId)} onChange={(e) => setPool(e.target.checked ? [...pool, s.sectionOfferingId] : pool.filter((x) => x !== s.sectionOfferingId))} />
                  Section {s.sectionCode}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <ComboboxField label="Teacher" value={teacher} onChange={setTeacher} options={[{ value: '', label: 'From Assign Classes', hint: 'Recommended' }, ...teachers.map((t) => ({ value: t.employeeId, label: t.fullName }))]} searchPlaceholder="Search teachers…" hint="Leave as it is, and the teacher comes from Assign Classes. Pick one only if that is unclear." />
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── members and health

function StudentRow({ s, action }: { s: GroupHealthStudentDTO; action: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span>
        <span className="font-semibold">{s.fullName}</span> <span className="text-muted">· {s.sectionLabel ?? 'No section'}</span>
      </span>
      {action}
    </li>
  );
}

function AddByHand({ group, onAdd }: { group: TeachingGroupDTO; onAdd: (studentId: string) => void }) {
  const ctx = useStudentContext();
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 300);
  const list = useStudents({ q: q || undefined, locationId: ctx.locationId, academicSessionId: ctx.sessionId, pageSize: 6 }, q.length >= 2);
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input aria-label="Search students to add" className="pl-9" placeholder="Search by name or admission number…" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </div>
      <ul className="divide-y divide-line empty:hidden">
        {list.data?.items.map((s) => (
          <li key={s.studentId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
            <span>
              <span className="font-semibold">{s.fullName}</span> <span className="text-muted">· {s.classSection?.label ?? 'No class'}</span>
            </span>
            <Button size="sm" variant="outline" aria-label={`Add ${s.fullName} to ${group.name}`} onClick={() => onAdd(s.studentId)}>
              <UserPlus /> Add
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MembersModal({ plan, group, teachers, onClose }: { plan: TimetablePlanDTO; group: TeachingGroupDTO; teachers: PlanTeacherDTO[]; onClose: () => void }) {
  const { can } = useAuth();
  const members = useGroupMembers(group.groupId);
  const health = useGroupHealth(group.groupId);
  const change = useTimetableMutation((body: { add?: string[]; remove?: string[] }) => api.post(`/teaching-groups/${group.groupId}/members`, { add: body.add ?? [], remove: body.remove ?? [] }), { success: 'Members updated.' });
  const pick = useTimetableMutation((employeeId: string) => api.patch(`/teaching-groups/${group.groupId}`, { version: group.version, teacherIds: [employeeId] }), { success: 'Teacher saved.' });
  const h = health.data;
  const candidates = group.teacher.candidates.length > 0 ? group.teacher.candidates : teachers.map((t) => ({ employeeId: t.employeeId, fullName: t.fullName }));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={group.name} description={`${group.subjectName ?? 'Activity'} · ${group.sectionPool.map((s) => s.label).join(', ') || 'No sections'}`} className="max-w-2xl" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="space-y-4">
        {group.teacher.status !== 'OK' && (
          <Alert tone="warning" title={group.teacher.status === 'PICK_ONE' ? 'Pick a teacher' : 'No teacher yet'}>
            <div className="mt-2 max-w-sm">
              <ComboboxField label="Teacher" value="" onChange={(v) => v && pick.mutate(v)} options={candidates.map((c) => ({ value: c.employeeId, label: c.fullName }))} placeholder="Choose teacher" searchPlaceholder="Search teachers…" hint={group.teacher.status === 'PICK_ONE' ? 'Assign Classes lists more than one teacher for this subject.' : 'No one is assigned in Assign Classes yet. You can pick one here.'} />
            </div>
          </Alert>
        )}
        {group.teacher.status === 'OK' && <p className="text-sm">Teacher: <b>{group.teacher.names.join(', ')}</b> <span className="text-muted">({group.teacher.source === 'ASSIGNMENT' ? 'From Assign Classes' : 'Chosen here'})</span></p>}

        {h && !h.healthy && (
          <section aria-label="Students to fix" className="space-y-3 rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
            <h3 className="font-bold">Needs a look</h3>
            {h.notInAnyGroup.length > 0 && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{h.notInAnyGroup.length} {h.notInAnyGroup.length === 1 ? 'student chose' : 'students chose'} this subject but {h.notInAnyGroup.length === 1 ? 'is' : 'are'} in no group</p>
                  <Button size="sm" variant="outline" onClick={() => change.mutate({ add: h.notInAnyGroup.map((s) => s.studentId) })}>
                    Add All To This Group
                  </Button>
                </div>
                <ul className="divide-y divide-line/60">
                  {h.notInAnyGroup.map((s) => (
                    <StudentRow key={s.studentId} s={s} action={<Button size="sm" variant="outline" aria-label={`Add ${s.fullName}`} onClick={() => change.mutate({ add: [s.studentId] })}><UserPlus /> Add</Button>} />
                  ))}
                </ul>
              </div>
            )}
            {h.leftSection.length > 0 && (
              <div>
                <p className="text-sm font-semibold">Added by hand, but no longer in this group’s sections</p>
                <ul className="divide-y divide-line/60">
                  {h.leftSection.map((s) => (
                    <StudentRow key={s.studentId} s={s} action={<Button size="sm" variant="outline" aria-label={`Remove ${s.fullName}`} onClick={() => change.mutate({ remove: [s.studentId] })}><UserMinus /> Remove</Button>} />
                  ))}
                </ul>
              </div>
            )}
            {h.inTwoGroups.length > 0 && (
              <div>
                <p className="text-sm font-semibold">In this group and another group for the same subject</p>
                <ul className="divide-y divide-line/60">
                  {h.inTwoGroups.map((s) => (
                    <StudentRow key={s.studentId} s={s} action={null} />
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <section aria-label="Members" className="space-y-2">
          <h3 className="font-bold">Members ({members.data?.total ?? group.memberCount})</h3>
          {members.isLoading && <Skeleton className="h-24" role="status" aria-label="Loading members" />}
          {members.isError && <ErrorState error={members.error} onRetry={() => void members.refetch()} />}
          <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-xl border border-line empty:hidden">
            {members.data?.items.map((m) => (
              <li key={m.studentId} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                <span>
                  <span className="font-semibold">{m.fullName}</span> <span className="text-muted">· {m.sectionLabel ?? 'No section'}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={m.source === 'MANUAL' ? 'sun' : 'neutral'}>{m.source === 'MANUAL' ? 'Added by hand' : 'Subject choice'}</Badge>
                  {m.source === 'MANUAL' && (
                    <Button size="sm" variant="ghost" aria-label={`Remove ${m.fullName}`} onClick={() => change.mutate({ remove: [m.studentId] })}>
                      <UserMinus />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {members.data?.total === 0 && <p className="text-sm text-muted">No members yet. Students appear here when they choose this subject in one of the group’s sections.</p>}
        </section>

        {can('student:view') && (
          <section aria-label="Add a student by hand" className="space-y-2">
            <h3 className="font-bold">Add a student by hand</h3>
            <p className="text-sm text-muted">Only needed when a student should join without choosing the subject.</p>
            <AddByHand group={group} onAdd={(id) => change.mutate({ add: [id] })} />
          </section>
        )}
      </div>
      <span className="sr-only">{plan.planName}</span>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── the tab

export function GroupsTab({ plan, canEdit }: { plan: TimetablePlanDTO; canEdit: boolean }) {
  const groups = useGroups(plan.planId);
  const teachers = usePlanTeachers(plan.planId);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const archive = useTimetableMutation((g: TeachingGroupDTO) => api.patch(`/teaching-groups/${g.groupId}`, { version: g.version, status: 'ARCHIVED' }), { success: 'Group archived.' });
  const list = groups.data ?? [];
  const current = list.find((g) => g.groupId === open);

  return (
    <div className="space-y-4">
      <TabIntro title="Teaching Groups" need="optional">
        {GROUPS_INTRO}
      </TabIntro>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <HelpHeading title="Groups" help={TIPS.teachingGroup} />
        {canEdit && (
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add Group
          </Button>
        )}
      </div>
      {groups.isLoading && <Skeleton className="h-32 rounded-card" role="status" aria-label="Loading groups" />}
      {groups.isError && <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />}
      {groups.data && list.length === 0 && <EmptyState title="No Teaching Groups yet" description="Most schools only need these for languages and electives. If every section studies together, you can skip this step." action={canEdit ? <Button onClick={() => setAdding(true)}>Add Group</Button> : undefined} />}
      <ul className="grid gap-3 lg:grid-cols-2" aria-label="Teaching Groups">
        {list.map((g) => (
          <li key={g.groupId}>
            <Card className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-base font-bold">
                    {g.name} <Badge tone="neutral">{KIND_LABELS[g.kind]}</Badge>
                  </h3>
                  <p className="text-sm text-muted">
                    {g.subjectName ?? 'No subject'} · {g.className ?? 'Any class'} · {g.sectionPool.map((s) => s.label).join(', ') || 'No sections'}
                  </p>
                </div>
                {g.healthBadge ? <Badge tone="warning">{g.healthBadge}</Badge> : <Badge tone="success">Looks good</Badge>}
              </div>
              <p className="text-sm">
                {g.memberCount} {g.memberCount === 1 ? 'student' : 'students'} ·{' '}
                {g.teacher.status === 'OK' ? (
                  <>
                    Teacher: <b>{g.teacher.names.join(', ')}</b> <span className="text-muted">({g.teacher.source === 'ASSIGNMENT' ? 'From Assign Classes' : 'Chosen here'})</span>
                  </>
                ) : (
                  <span className="font-semibold text-warning">{g.teacher.status === 'PICK_ONE' ? 'Pick a teacher' : 'No teacher yet'}</span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setOpen(g.groupId)}>
                  {g.healthBadge ? 'Fix' : 'Members'}
                </Button>
                {canEdit && (
                  <Button size="sm" variant="ghost" onClick={() => archive.mutate(g)}>
                    Archive
                  </Button>
                )}
                <InfoTip label={`About ${g.name}`}>
                  <p>Members are worked out from subject choice, so you never type them in. Students you add by hand are marked.</p>
                </InfoTip>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {adding && <AddGroup plan={plan} teachers={teachers.data ?? []} onClose={() => setAdding(false)} />}
      {current && <MembersModal plan={plan} group={current} teachers={teachers.data ?? []} onClose={() => setOpen(null)} />}
    </div>
  );
}
