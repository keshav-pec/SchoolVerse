import { useState } from 'react';
import {
  MASTER_STATUSES,
  codeFromName,
  type DepartmentDTO,
  type DesignationDTO,
  type SuggestedMastersDTO,
} from '@shared';
import { Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { Badge } from '@/components/ui/badge';
import { useDepartments, useDesignations, usePeopleMutation, suggestedLabel } from './api';

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
      description="The code is unique in your school. Names can change later; codes can't."
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
          hint="Letters, numbers, hyphens or underscores."
        />
      </div>
    </ConfirmDialog>
  );
}

function MasterTable({
  kind,
  title,
  description,
  rows,
  loading,
  error,
  retry,
}: {
  kind: 'departments' | 'designations';
  title: string;
  description: string;
  rows: MasterRow[];
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  const noun = kind === 'departments' ? 'department' : 'designation';
  const [adding, setAdding] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const toggle = usePeopleMutation(
    (v: { id: string; status: string }) => api.patch(`/${kind}/${v.id}`, { status: v.status }),
    {},
  );
  const suggest = usePeopleMutation(
    (_: void) =>
      api.post<SuggestedMastersDTO<DepartmentDTO | DesignationDTO>>(`/${kind}/suggested`),
    { quiet: true },
  );

  const runSuggest = async () => {
    setSuggesting(true);
    try {
      toast.success(suggestedLabel(await suggest.mutateAsync()));
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setSuggesting(false);
    }
  };

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runSuggest()}
            loading={suggesting}
            loadingText="Adding…"
          >
            <Sparkles /> Add suggested list
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add {noun}
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
          description="Add the suggested starter list, or add your own."
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
      <p className="mt-3 text-[13px] text-muted">
        Inactive entries stay on existing employees but can’t be chosen for new ones.
      </p>
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
        description="A designation is a title, not a permission. What a person can do comes from the role on their login."
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <MasterTable
          kind="departments"
          title="Departments"
          description="Academics, Accounts, Library…"
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
          description="PGT, TGT, Principal, Accountant…"
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
