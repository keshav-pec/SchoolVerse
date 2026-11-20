import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createIdentifierSchema, IDENTIFIER_STATUSES, IDENTIFIER_STATUS_LABELS, IDENTIFIER_TYPE_SUGGESTIONS, type SchoolIdentifierDTO } from '@shared';
import { ExternalLink, FileBadge, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { FormComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { StatusPill } from '@/components/sv/status-pill';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useDeleteIdentifier, useIdentifiers, useSaveIdentifier } from './api';

interface IdentifierForm {
  identifierType: string;
  identifierValue: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate: string;
  documentUrl: string;
  status: SchoolIdentifierDTO['status'];
}

const FIELDS = ['identifierType', 'identifierValue', 'issuingAuthority', 'issueDate', 'expiryDate', 'documentUrl', 'status'] as const;

const EMPTY: IdentifierForm = { identifierType: '', identifierValue: '', issuingAuthority: '', issueDate: '', expiryDate: '', documentUrl: '', status: 'ACTIVE' };

function IdentifierDrawer({ schoolId, identifier, open, onOpenChange }: { schoolId: string; identifier: SchoolIdentifierDTO | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const save = useSaveIdentifier(schoolId);
  const [formError, setFormError] = useState<string | null>(null);
  const editing = !!identifier;

  const form = useForm<IdentifierForm>({
    resolver: zodResolver(createIdentifierSchema) as unknown as Resolver<IdentifierForm>,
    values: identifier
      ? {
          identifierType: identifier.identifierType,
          identifierValue: identifier.identifierValue,
          issuingAuthority: identifier.issuingAuthority ?? '',
          issueDate: identifier.issueDate?.slice(0, 10) ?? '',
          expiryDate: identifier.expiryDate?.slice(0, 10) ?? '',
          documentUrl: identifier.documentUrl ?? '',
          status: identifier.status,
        }
      : EMPTY,
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await save.mutateAsync({ identifierId: identifier?.identifierId, values });
      toast.success(editing ? 'Official identifier updated.' : 'Official identifier added.');
      onOpenChange(false);
    } catch (err) {
      setFormError(applyServerErrors(err, form.setError, FIELDS));
    }
  });

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title={editing ? 'Edit official identifier' : 'Add official identifier'} description="Affiliation, registration or tax numbers. Add whatever applies to your school.">
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DrawerBody className="space-y-5">
            {formError && <Alert tone="danger">{formError}</Alert>}
            <div>
              <TextField label="Identifier type" required list="identifier-types" placeholder="e.g. Affiliation Number" error={errors.identifierType?.message} {...form.register('identifierType')} />
              <datalist id="identifier-types">
                {IDENTIFIER_TYPE_SUGGESTIONS.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <TextField label="Identifier value" required error={errors.identifierValue?.message} {...form.register('identifierValue')} />
            <TextField label="Issuing authority" placeholder="e.g. CBSE" error={errors.issuingAuthority?.message} {...form.register('issuingAuthority')} />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField label="Issue date" type="date" error={errors.issueDate?.message} {...form.register('issueDate')} />
              <TextField label="Expiry date" type="date" error={errors.expiryDate?.message} {...form.register('expiryDate')} />
            </div>
            <TextField label="Document link" placeholder="https://…" hint="Optional link to the certificate or document." error={errors.documentUrl?.message} {...form.register('documentUrl')} />
            <FormComboboxField
              label="Status"
              required
              control={form.control}
              name="status"
              options={IDENTIFIER_STATUSES.map((s) => ({ value: s, label: IDENTIFIER_STATUS_LABELS[s] }))}
              searchPlaceholder="Search statuses…"
              error={errors.status?.message}
            />
          </DrawerBody>
          <DrawerFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting} loadingText="Saving…">
              {editing ? 'Save Changes' : 'Add Identifier'}
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

export function IdentifiersCard({ schoolId }: { schoolId: string }) {
  const { can } = useAuth();
  const list = useIdentifiers(schoolId, can('school:view_config'));
  const remove = useDeleteIdentifier(schoolId);
  const [drawer, setDrawer] = useState<{ open: boolean; identifier: SchoolIdentifierDTO | null; nonce: number }>({ open: false, identifier: null, nonce: 0 });
  const [deleting, setDeleting] = useState<SchoolIdentifierDTO | null>(null);

  if (!can('school:view_config')) return null;
  const rows = list.data ?? [];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Official identifiers</CardTitle>
          <CardDescription>Affiliation, registration and tax numbers. None are required, and any board is welcome.</CardDescription>
        </div>
        <Can permission="school:edit">
          <Button variant="outline" size="sm" onClick={() => setDrawer((d) => ({ open: true, identifier: null, nonce: d.nonce + 1 }))}>
            <Plus /> Add Identifier
          </Button>
        </Can>
      </CardHeader>

      {list.isLoading && (
        <div className="space-y-3" role="status" aria-label="Loading identifiers">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      {list.isSuccess && rows.length === 0 && (
        <EmptyState
          illustration={<FileBadge className="size-12 text-muted" aria-hidden="true" />}
          title="No official identifiers yet"
          description="Add your affiliation number, UDISE+ code or registration details when you have them."
          className="py-6"
        />
      )}
      {list.isSuccess && rows.length > 0 && (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">Official identifiers</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs font-bold tracking-wide text-muted uppercase">
                <th scope="col" className="px-2 py-2.5">Type</th>
                <th scope="col" className="px-2 py-2.5">Value</th>
                <th scope="col" className="px-2 py-2.5">Authority</th>
                <th scope="col" className="px-2 py-2.5">Valid</th>
                <th scope="col" className="px-2 py-2.5">Status</th>
                <th scope="col" className="px-2 py-2.5"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.identifierId}>
                  <td className="px-2 py-3 font-semibold">{r.identifierType}</td>
                  <td className="px-2 py-3 font-mono text-[13px]">
                    {r.identifierValue}
                    {r.documentUrl && (
                      <a href={r.documentUrl} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex align-middle text-brand" aria-label={`Open document for ${r.identifierType}`}>
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </td>
                  <td className="px-2 py-3">{r.issuingAuthority ?? '—'}</td>
                  <td className="px-2 py-3 whitespace-nowrap text-muted">
                    {formatDateOnly(r.issueDate)} → {formatDateOnly(r.expiryDate)}
                  </td>
                  <td className="px-2 py-3">
                    <StatusPill kind="identifier" status={r.status} />
                  </td>
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    <Can permission="school:edit">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${r.identifierType}`} onClick={() => setDrawer((d) => ({ open: true, identifier: r, nonce: d.nonce + 1 }))}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Delete ${r.identifierType}`} onClick={() => setDeleting(r)}>
                        <Trash2 className="text-danger" />
                      </Button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <IdentifierDrawer key={drawer.nonce} schoolId={schoolId} identifier={drawer.identifier} open={drawer.open} onOpenChange={(open) => setDrawer((d) => ({ ...d, open }))} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        icon={<Trash2 className="size-5" />}
        title={`Remove ${deleting?.identifierType ?? 'identifier'}?`}
        description="This official identifier will be removed from the school profile."
        confirmLabel="Remove identifier"
        loadingLabel="Removing…"
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.identifierId);
          toast.success('Official identifier removed.');
        }}
      />
    </Card>
  );
}
