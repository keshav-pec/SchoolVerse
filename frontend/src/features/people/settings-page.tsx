import { useState } from 'react';
import { MASTER_STATUSES, codeFromName } from '@shared';
import { Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { Badge } from '@/components/ui/badge';
import { useAddSuggestedMasters, useDepartments, useDesignations, usePeopleMutation } from './api';

interface MasterRow {
  id: string;
  code: string;
  name: string;
  status: (typeof MASTER_STATUSES)[number];
}

function AddDialog({
  kind,
  onClose,
}: {
  kind: 'departments' | 'designations';
  onClose: () => void;
}) {
  const noun = kind === 'departments' ? 'department' : 'designation';
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const add = usePeopleMutation((body: object) => api.post(`/${kind}`, body), {
    quiet: true,
    success: `${noun[0]!.toUpperCase()}${noun.slice(1)} added.`,
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Add a ${noun}`}
      description="The code is a short ID used in exports. You can rename later, but the code can’t change."
      confirmLabel={`Add ${noun}`}
      loadingLabel="Adding…"
      onConfirm={async () => {
        if (!name.trim()) throw new FormProblem('Enter a name.');
        const finalCode = (code || codeFromName(name)).trim();
        if (!finalCode) throw new FormProblem('Enter a code.');
        await add.mutateAsync({ name: name.trim(), code: finalCode });
      }}
    >
      <div className="space-y-4">
        <TextField
          label="Name"
          required
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!touched) setCode(codeFromName(e.target.value));
          }}
        />
        <TextField
          label="Code"
          required
          value={code}
          onChange={(e) => {
            setTouched(true);
            setCode(e.target.value.toUpperCase());
          }}
          hint="Filled in from the name. Letters, numbers, - or _ only."
        />
      </div>
    </ConfirmDialog>
  );
}

function MasterTable({
  kind,
  title,
  description,
  help,
  rows,
  loading,
  error,
  retry,
}: {
  kind: 'departments' | 'designations';
  title: string;
  description: string;
  help: React.ReactNode;
  rows: MasterRow[];
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const toggle = usePeopleMutation(
    (v: { id: string; status: string }) => api.patch(`/${kind}/${v.id}`, { status: v.status }),
    {},
  );
  const suggest = useAddSuggestedMasters(kind);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div>
          <HelpHeading title={title} help={help} />
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={suggest.run}
            loading={suggest.pending}
            loadingText="Adding…"
          >
            <Sparkles /> Add Suggested List
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add {kind === 'departments' ? 'Department' : 'Designation'}
          </Button>
        </div>
      </CardHeader>
      {loading ? (
        <Skeleton className="h-32" />
      ) : error ? (
        <ErrorState error={error} onRetry={retry} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={`No ${kind} yet`}
          description="Press Add Suggested List to add the common ones in one click, then add any others your school uses."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="border-b border-line">
              <tr>
                {['Code', 'Name', 'Status', ''].map((h, i) => (
                  <th
                    key={i}
                    scope="col"
                    className="px-3 py-2.5 text-left text-xs font-bold tracking-wide text-muted uppercase"
                  >
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2.5 font-mono text-[13px] font-semibold">{r.code}</td>
                  <td className="px-3 py-2.5 font-semibold">{r.name}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={r.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {r.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        toggle.mutate({
                          id: r.id,
                          status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                        })
                      }
                      aria-label={`${r.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${r.name}`}
                    >
                      {r.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddDialog kind={kind} onClose={() => setAdding(false)} />}
    </Card>
  );
}

/** `/people/settings`: the departments and designations people are filed under. */
export function PeopleSettingsPage() {
  const departments = useDepartments();
  const designations = useDesignations();
  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Departments & Designations"
        description="The teams and job titles you file staff under."
      />
      <TabIntro title="Departments & Designations" className="mb-4">
        <p>
          A <b>department</b> is a team, like Academics or Accounts. A <b>designation</b> is a job
          title, like PGT or Accountant. Every employee needs one of each.
        </p>
        <p>
          New here? Press <b>Add Suggested List</b> on both cards to add the common ones, then add
          anything else your school uses.
        </p>
      </TabIntro>
      <div className="grid gap-4 xl:grid-cols-2">
        <MasterTable
          kind="departments"
          title="Departments"
          description="Teams, e.g. Academics, Accounts, Library."
          help={
            <>
              <p>The team a person belongs to. Used to filter the staff list and in exports.</p>
              <p><b>Deactivate</b> hides an entry when adding staff. People already filed under it keep it. You can activate it again at any time.</p>
            </>
          }
          rows={(departments.data ?? []).map((d) => ({
            id: d.departmentId,
            code: d.code,
            name: d.name,
            status: d.status,
          }))}
          loading={departments.isLoading}
          error={departments.error}
          retry={() => void departments.refetch()}
        />
        <MasterTable
          kind="designations"
          title="Designations"
          description="Job titles, e.g. PGT, TGT, Principal, Accountant."
          help={
            <>
              <p>The job title on their profile. <b>PGT</b> = Post Graduate Teacher, <b>TGT</b> = Trained Graduate Teacher, <b>PRT</b> = Primary Teacher.</p>
              <p>A title gives no access. What someone can do comes from the role on their login.</p>
              <p><b>Deactivate</b> hides an entry when adding staff. People already filed under it keep it. You can activate it again at any time.</p>
            </>
          }
          rows={(designations.data ?? []).map((d) => ({
            id: d.designationId,
            code: d.code,
            name: d.name,
            status: d.status,
          }))}
          loading={designations.isLoading}
          error={designations.error}
          retry={() => void designations.refetch()}
        />
      </div>
    </>
  );
}
