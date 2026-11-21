import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { RELATIONSHIP_TYPES, type GuardianChildDTO, type GuardianFamilyDTO, type StudentDirectoryDTO } from '@shared';
import { ArrowLeft, Mail, Pencil, Phone, Plus, Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { api, ApiError } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { formatPhone } from '@/lib/format';
import { NotFoundPage } from '../errors/not-found-page';
import { StudentNotFound } from './not-found';
import { AddStudentDrawer } from './add-student-drawer';
import { useFamily, useStudentMutation, useStudents } from './api';
import { useStudentContext } from './context';
import { placementText, StudentStatusPill } from './student-bits';

/** Edit the parent once; every child shows the new details. Only what changed is sent. */
function EditParentDialog({ family, onClose }: { family: GuardianFamilyDTO; onClose: () => void }) {
  const start = { first: family.legalFirstName, last: family.legalLastName, phone: family.phone ?? '', email: family.email ?? '' };
  const [v, setV] = useState(start);
  const save = useStudentMutation((body: object) => api.patch<GuardianFamilyDTO>(`/guardians/${family.personId}`, body), { quiet: true, success: 'Saved. Every child shows the new details.' });
  const personal = family.phone !== null || family.email !== null || family.address !== null;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${family.fullName}`}
      description={`These details are shared by all ${family.children.length === 1 ? 'the' : family.children.length} ${family.children.length === 1 ? 'child' : 'children'}. Change them once.`}
      confirmLabel="Save Changes"
      loadingLabel="Saving…"
      onConfirm={async () => {
        if (!v.first.trim()) throw new FormProblem('Enter the parent’s name.');
        const body: Record<string, unknown> = {};
        if (v.first !== start.first) body.legalFirstName = v.first.trim();
        if (v.last !== start.last) body.legalLastName = v.last.trim();
        if (personal && v.phone !== start.phone) body.primaryPhone = v.phone.trim() || null;
        if (personal && v.email !== start.email) body.primaryEmail = v.email.trim() || null;
        if (Object.keys(body).length > 0) await save.mutateAsync(body);
      }}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Name" required value={v.first} onChange={(e) => setV({ ...v, first: e.target.value })} />
          <TextField label="Last name" value={v.last} onChange={(e) => setV({ ...v, last: e.target.value })} />
        </div>
        {personal && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Phone" type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
            <TextField label="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** Link a student who already exists to this parent (for example a brother or sister added earlier). */
function LinkChildDialog({ family, onClose }: { family: GuardianFamilyDTO; onClose: () => void }) {
  const [text, setText] = useState('');
  const [relationship, setRelationship] = useState('');
  const typed = useDebouncedValue(text.trim(), 350);
  const ctx = useStudentContext();
  const found = useStudents({ q: typed, academicSessionId: ctx.sessionId, pageSize: 8 }, typed.length >= 2);
  const already = new Set(family.children.map((c) => c.studentId));
  const [error, setError] = useState<string | null>(null);
  const link = useStudentMutation((vars: { studentId: string }) => api.post(`/students/${vars.studentId}/link-existing-guardian`, { guardianPersonId: family.personId, relationshipType: relationship }), { quiet: true });

  const use = async (s: StudentDirectoryDTO) => {
    if (!relationship) return setError('Choose how this parent is related to the student first.');
    setError(null);
    try {
      await link.mutateAsync({ studentId: s.studentId });
      toast.success(`${s.fullName} is now linked to ${family.fullName}.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link the student.');
    }
  };

  return (
    <ConfirmDialog open onOpenChange={(open) => !open && onClose()} title="Link an existing student" description={`Pick a student who is already in the school. ${family.fullName} becomes one of their parents.`} confirmLabel="Done" loadingLabel="…" onConfirm={() => undefined}>
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <ComboboxField label="Relationship" required value={relationship} onChange={setRelationship} options={RELATIONSHIP_TYPES.map((r) => ({ value: r, label: r }))} placeholder="Choose…" searchPlaceholder="Search…" />
        <div className="space-y-1.5">
          <label htmlFor="find-student" className="text-sm font-semibold">
            Find the student
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input id="find-student" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or admission number" className="pl-10" autoComplete="off" />
          </div>
        </div>
        <ul className="space-y-2" aria-live="polite">
          {(found.data?.items ?? []).map((s) => (
            <li key={s.studentId} className="flex items-center gap-3 rounded-lg border border-line p-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{s.fullName}</p>
                <p className="text-xs text-muted">{[s.admissionNumber, placementText(s.classSection, s.rollNumber)].filter(Boolean).join(' · ')}</p>
              </div>
              <Button size="sm" variant="outline" disabled={already.has(s.studentId)} onClick={() => void use(s)}>
                {already.has(s.studentId) ? 'Already linked' : 'Link'}
              </Button>
            </li>
          ))}
          {typed.length >= 2 && found.isSuccess && found.data.items.length === 0 && <li className="text-sm text-muted">No student found.</li>}
        </ul>
      </div>
    </ConfirmDialog>
  );
}

function ChildRow({ child }: { child: GuardianChildDTO }) {
  const live = child.link.status === 'ACTIVE' || child.link.status === 'PLANNED';
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Avatar name={child.fullName} />
      <div className="min-w-0 flex-1">
        <Link to={`/students/${child.studentId}`} className="font-semibold text-ink hover:text-brand hover:underline">
          {child.fullName}
        </Link>
        <p className="text-xs text-muted">
          <span className="font-mono">{child.admissionNumber ?? 'No admission no.'}</span> · {placementText(child.classSection, null)} · {child.link.relationshipType}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {child.link.isPrimary && live && <Badge tone="brand">Primary parent</Badge>}
        {child.link.isEmergencyContact && live && <Badge tone="warning">Emergency contact</Badge>}
        {!live && <Badge tone="neutral">Link ended</Badge>}
        <StudentStatusPill status={child.studentStatus} />
      </div>
    </li>
  );
}

function FamilyView({ personId }: { personId: string }) {
  const q = useFamily(personId);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [adding, setAdding] = useState(false);

  if (q.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading family" />;
  if (q.error instanceof ApiError && q.error.status === 404) return <StudentNotFound backTo="/families" backLabel="Go To Families" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const f = q.data;

  return (
    <>
      <Link to="/families" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> Families
      </Link>
      <header className="mb-4 flex flex-col gap-3 rounded-card border border-line bg-white p-4 shadow-card sm:flex-row sm:items-center sm:px-5">
        <Avatar name={f.fullName} className="size-14 text-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] leading-tight font-extrabold break-words">{f.fullName}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            {f.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="size-3.5" aria-hidden="true" /> {formatPhone(f.phone)}
              </span>
            )}
            {f.email && (
              <span className="inline-flex items-center gap-1.5">
                <Mail className="size-3.5" aria-hidden="true" /> {f.email}
              </span>
            )}
            <span>
              {f.children.length} {f.children.length === 1 ? 'child' : 'children'}
            </span>
          </p>
        </div>
        <Can permission="guardian:manage">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Edit Parent Details
          </Button>
        </Can>
      </header>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Contact details</CardTitle>
          </CardHeader>
          <InfoGrid>
            <InfoItem label="Phone">{f.phone ? formatPhone(f.phone) : undefined}</InfoItem>
            <InfoItem label="Email">{f.email}</InfoItem>
            <InfoItem label="Address">{f.address ? [f.address.line1, f.address.city, f.address.state, f.address.postalCode].filter(Boolean).join(', ') || undefined : undefined}</InfoItem>
          </InfoGrid>
          <p className="mt-3 text-[13px] text-muted">Change these once. Every child shows the new details.</p>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Children</CardTitle>
            <Can permission={['student:manage', 'guardian:manage']}>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setLinking(true)}>
                  <Plus /> Link Existing Student
                </Button>
                <Button size="sm" onClick={() => setAdding(true)}>
                  <UserPlus /> Add New Child
                </Button>
              </div>
            </Can>
          </CardHeader>
          <ul className="divide-y divide-line" aria-label="Children">
            {f.children.map((c) => (
              <ChildRow key={c.studentId} child={c} />
            ))}
          </ul>
        </Card>
      </div>

      {editing && <EditParentDialog family={f} onClose={() => setEditing(false)} />}
      {linking && <LinkChildDialog family={f} onClose={() => setLinking(false)} />}
      <AddStudentDrawer open={adding} onOpenChange={setAdding} parent={{ personId: f.personId, fullName: f.fullName }} />
    </>
  );
}

/** `/families/:personId`: one parent and all their children. */
export function FamilyPage() {
  const { personId } = useParams();
  if (!personId) return <NotFoundPage />;
  return <FamilyView personId={personId} />;
}

