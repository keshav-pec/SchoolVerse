import { useState } from 'react';
import {
  GOVERNMENT_ID_LABELS,
  GOVERNMENT_ID_TYPES,
  updateRestrictedSchema,
  type EmployeeProfileDTO,
  type GovernmentIdType,
  type RestrictedEmployeeProfileDTO,
  type RestrictedField,
  type RevealedValueDTO,
} from '@shared';
import { Landmark, Lock, Pencil, Save, ShieldCheck } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { isStepUpCancelled, useStepUp } from '@/lib/step-up';
import { usePeopleMutation, useRestricted } from '../api';
import { RevealableValue } from '../revealable-value';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-6">
      <dt className="w-44 shrink-0 text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm font-semibold">{children}</dd>
    </div>
  );
}

/** Add, replace or remove IDs and bank details (step-up first, checked again by the server). */
function EditDrawer({
  employee,
  restricted,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  restricted: RestrictedEmployeeProfileDTO;
  onClose: () => void;
}) {
  const { withStepUp } = useStepUp();
  const held = new Map(restricted.governmentIds.map((g) => [g.type, g.masked]));
  const [dob, setDob] = useState('');
  const [ids, setIds] = useState<Partial<Record<GovernmentIdType, string>>>({});
  const [removed, setRemoved] = useState<Set<GovernmentIdType>>(new Set());
  const [bank, setBank] = useState({
    accountHolderName: restricted.bank?.accountHolderName ?? '',
    accountNumber: '',
    ifsc: restricted.bank?.ifsc ?? '',
    bankName: restricted.bank?.bankName ?? '',
  });
  const [removeBank, setRemoveBank] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const saveRestricted = usePeopleMutation(
    (body: object) =>
      withStepUp(() => api.put(`/employees/${employee.employeeId}/restricted`, body)),
    { quiet: true },
  );
  const saveDob = usePeopleMutation(
    (value: string) => api.patch(`/employees/${employee.employeeId}`, { dateOfBirth: value }),
    { quiet: true },
  );
  const pending = saveRestricted.isPending || saveDob.isPending;

  const submit = async () => {
    setErrors({});
    setFormError(null);
    const entries = [
      ...GOVERNMENT_ID_TYPES.filter((t) => (ids[t] ?? '').trim() !== '').map((t) => ({
        type: t,
        value: ids[t]!.trim(),
      })),
      ...[...removed].filter((t) => !(ids[t] ?? '').trim()).map((t) => ({ type: t, value: null })),
    ];
    const body: { governmentIds?: typeof entries; bank?: object | null } = {};
    if (entries.length > 0) body.governmentIds = entries;
    if (removeBank) body.bank = null;
    else if (bank.accountNumber.trim()) body.bank = { ...bank };
    else if (
      restricted.bank &&
      (bank.ifsc !== restricted.bank.ifsc ||
        bank.bankName !== restricted.bank.bankName ||
        bank.accountHolderName !== restricted.bank.accountHolderName)
    ) {
      return setErrors({
        'bank.accountNumber': 'Enter the account number again to change the bank details.',
      });
    }
    if (!body.governmentIds && body.bank === undefined && !dob) return onClose();

    if (body.governmentIds || body.bank !== undefined) {
      const parsed = updateRestrictedSchema.safeParse(body);
      if (!parsed.success) {
        const next: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const [root, index] = issue.path;
          if (root === 'governmentIds' && typeof index === 'number')
            next[`id.${entries[index]?.type}`] = issue.message;
          else if (root === 'bank' && typeof index === 'string')
            next[`bank.${index}`] = issue.message;
          else next._form = issue.message;
        }
        return setErrors(next);
      }
    }
    try {
      if (body.governmentIds || body.bank !== undefined) await saveRestricted.mutateAsync(body);
      if (dob) await saveDob.mutateAsync(dob);
      onClose();
    } catch (err) {
      if (isStepUpCancelled(err)) return;
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0)
        setFormError(Object.values(err.fieldErrors)[0]!);
      else setFormError(messageFor(err));
    }
  };

  return (
    <Drawer open onOpenChange={(open) => !open && !pending && onClose()}>
      <DrawerContent
        title="Edit IDs and bank details"
        description="Saved in locked (encrypted) form. Leave a box empty to keep what is already saved."
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DrawerBody className="space-y-6">
            {(formError || errors._form) && (
              <Alert tone="danger">{formError ?? errors._form}</Alert>
            )}
            <Can permission="employee:manage">
              <TextField
                label="Date of birth"
                type="date"
                hint={
                  restricted.dateOfBirth
                    ? `Saved: ${restricted.dateOfBirth.masked}. Pick a date only to replace it.`
                    : 'Not saved yet.'
                }
                value={dob}
                onChange={(e) => setDob(e.target.value)}
              />
            </Can>
            <fieldset className="space-y-4">
              <legend className="mb-1 text-sm font-bold">Government IDs</legend>
              {GOVERNMENT_ID_TYPES.map((t) => (
                <div key={t} className="flex items-start gap-3">
                  <TextField
                    containerClassName="flex-1"
                    label={GOVERNMENT_ID_LABELS[t]}
                    autoComplete="off"
                    placeholder={held.has(t) ? `Saved: ${held.get(t)}` : 'Not saved yet'}
                    hint={removed.has(t) ? 'Will be removed when you save.' : undefined}
                    value={ids[t] ?? ''}
                    onChange={(e) => setIds((v) => ({ ...v, [t]: e.target.value }))}
                    error={errors[`id.${t}`]}
                  />
                  {held.has(t) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-7"
                      onClick={() =>
                        setRemoved((r) => {
                          const next = new Set(r);
                          if (next.has(t)) next.delete(t);
                          else next.add(t);
                          return next;
                        })
                      }
                    >
                      {removed.has(t) ? 'Keep' : 'Remove'}
                    </Button>
                  )}
                </div>
              ))}
            </fieldset>
            <fieldset className="space-y-4">
              <legend className="mb-1 text-sm font-bold">Bank details</legend>
              {restricted.bank && (
                <p className="text-[13px] text-muted">
                  Saved: {restricted.bank.accountNumberMasked}. To change the bank details, type the
                  account number again.
                </p>
              )}
              <TextField
                label="Account holder name"
                value={bank.accountHolderName}
                onChange={(e) => setBank((b) => ({ ...b, accountHolderName: e.target.value }))}
                error={errors['bank.accountHolderName']}
                disabled={removeBank}
              />
              <TextField
                label="Account number"
                inputMode="numeric"
                autoComplete="off"
                value={bank.accountNumber}
                onChange={(e) => setBank((b) => ({ ...b, accountNumber: e.target.value }))}
                error={errors['bank.accountNumber']}
                disabled={removeBank}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="IFSC code"
                  autoComplete="off"
                  value={bank.ifsc}
                  onChange={(e) => setBank((b) => ({ ...b, ifsc: e.target.value }))}
                  error={errors['bank.ifsc']}
                  disabled={removeBank}
                />
                <TextField
                  label="Bank name"
                  value={bank.bankName}
                  onChange={(e) => setBank((b) => ({ ...b, bankName: e.target.value }))}
                  error={errors['bank.bankName']}
                  disabled={removeBank}
                />
              </div>
              {restricted.bank && (
                <label className="flex items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={removeBank}
                    onChange={(e) => setRemoveBank(e.target.checked)}
                    className="size-4 accent-[var(--color-brand)]"
                  />
                  Remove the bank details
                </label>
              )}
            </fieldset>
          </DrawerBody>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} loadingText="Saving…">
              <Save /> Save Changes
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

/** Date of birth, government IDs and bank details: masked by default, revealed one at a time after step-up. */
export function PersonalTab({ employee }: { employee: EmployeeProfileDTO }) {
  const q = useRestricted(employee.employeeId);
  const { withStepUp, ensureStepUp } = useStepUp();
  const [editing, setEditing] = useState(false);

  const reveal = (field: RestrictedField) => () =>
    withStepUp(() =>
      api.post<RevealedValueDTO>(`/employees/${employee.employeeId}/restricted/reveal`, { field }),
    );
  const startEdit = async () => {
    try {
      await ensureStepUp();
      setEditing(true);
    } catch (err) {
      if (!isStepUpCancelled(err)) throw err;
    }
  };

  if (q.isLoading) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError || !q.data)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const r = q.data;
  const nothing = !r.dateOfBirth && r.governmentIds.length === 0 && !r.bank;

  return (
    <div className="space-y-4">
      <TabIntro title="IDs & Bank Details" need="optional">
        <p>
          Date of birth, government IDs (such as PAN and Aadhaar) and bank details for salary. Add
          them when you have them; you can skip this for now.
        </p>
        <p>
          They are kept locked and show only the last few digits. Press <b>Show</b> to see one for
          30 seconds. We ask for your password first and note who looked.
        </p>
      </TabIntro>
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-brand" aria-hidden="true" /> IDs &amp; bank details
            </CardTitle>
            <CardDescription>
              Locked details. Showing one asks for your password and is recorded.
            </CardDescription>
          </div>
          <Can permission="employee:manage_restricted">
            {!employee.readOnly && (
              <Button variant="outline" size="sm" onClick={() => void startEdit()}>
                <Pencil /> Edit
              </Button>
            )}
          </Can>
        </CardHeader>

        <dl className="divide-y divide-line">
          <Row label="Legal name">{employee.fullName}</Row>
          <Row label="Date of birth">
            {r.dateOfBirth ? (
              <Can
                permission="employee:reveal_restricted"
                fallback={<span className="font-mono">{r.dateOfBirth.masked}</span>}
              >
                <RevealableValue
                  label="date of birth"
                  masked={r.dateOfBirth.masked}
                  reveal={reveal('DATE_OF_BIRTH')}
                />
              </Can>
            ) : (
              <span className="font-normal text-muted">Not saved yet</span>
            )}
          </Row>
          {GOVERNMENT_ID_TYPES.filter((t) => r.governmentIds.some((g) => g.type === t)).map((t) => {
            const masked = r.governmentIds.find((g) => g.type === t)!.masked;
            return (
              <Row key={t} label={GOVERNMENT_ID_LABELS[t]}>
                <Can
                  permission="employee:reveal_restricted"
                  fallback={<span className="font-mono">{masked}</span>}
                >
                  <RevealableValue
                    label={GOVERNMENT_ID_LABELS[t]}
                    masked={masked}
                    reveal={reveal(t)}
                  />
                </Can>
              </Row>
            );
          })}
          {r.bank && (
            <>
              <Row label="Bank">
                <span className="inline-flex items-center gap-2">
                  <Landmark className="size-4 text-muted" aria-hidden="true" /> {r.bank.bankName} ·
                  IFSC {r.bank.ifsc}
                </span>
              </Row>
              <Row label="Account holder">{r.bank.accountHolderName}</Row>
              <Row label="Account number">
                <Can
                  permission="employee:reveal_restricted"
                  fallback={<span className="font-mono">{r.bank.accountNumberMasked}</span>}
                >
                  <RevealableValue
                    label="account number"
                    masked={r.bank.accountNumberMasked}
                    reveal={reveal('BANK_ACCOUNT_NUMBER')}
                  />
                </Can>
              </Row>
            </>
          )}
        </dl>

        {nothing && (
          <EmptyState
            illustration={<Lock className="size-10 text-muted" aria-hidden="true" />}
            title="Nothing saved yet"
            description="Press Edit to add government IDs and bank details."
          />
        )}
        {editing && (
          <EditDrawer employee={employee} restricted={r} onClose={() => setEditing(false)} />
        )}
      </Card>
    </div>
  );
}
