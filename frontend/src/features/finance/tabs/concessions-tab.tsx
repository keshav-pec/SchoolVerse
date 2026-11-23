import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gift, Pencil, Plus } from 'lucide-react';
import { CONCESSION_TYPES, CONCESSION_VALUE_TYPES, STACK_MODES, type ConcessionAwardDTO, type ConcessionPolicyDTO, type ConcessionSuggestionDTO, type ConcessionType, type ConcessionValueType, type StackMode } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { bpsToPercentText, formatMoney, percentTextToBps } from '@/lib/money';
import { useStudentContext } from '../../students/context';
import { useStudentDocuments } from '../../students/lifecycle-api';
import { FIN, financeApi, useAwards, useConcessionPolicies, useFeeHeads, useFeePlans, useFinanceMutation, useStudentAccount } from '../api';
import { CONCESSION_TYPE_LABELS, CONCESSIONS_INTRO, TIP_CONCESSION_VS_PAYMENT, TIP_STACK } from '../help-copy';
import { StudentPicker, type PickedStudent } from '../student-picker';

const valueText = (type: ConcessionValueType, value: number) => (type === 'PERCENT' ? `${bpsToPercentText(value)}%` : `${formatMoney(value)} per fee`);

export function ConcessionsTab() {
  const ctx = useStudentContext();
  const policies = useConcessionPolicies();
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | ''>('');
  const awards = useAwards({ status: status || undefined });
  const suggestions = useQuery({ queryKey: [...FIN, 'suggestions', ctx.sessionId], queryFn: () => financeApi.suggestConcessions({ sessionId: ctx.sessionId }), enabled: !!ctx.sessionId });
  const [policy, setPolicy] = useState<ConcessionPolicyDTO | 'new' | null>(null);
  const [awarding, setAwarding] = useState(false);
  const [reviewing, setReviewing] = useState<ConcessionSuggestionDTO | null>(null);
  const [deciding, setDeciding] = useState<{ award: ConcessionAwardDTO; action: 'approve' | 'reject' | 'end' } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const awardMany = useFinanceMutation((awardsList: { studentId: string; policyId: string }[]) => financeApi.awardMany(awardsList), { quiet: true });

  const open = (suggestions.data ?? []).filter((s) => !s.alreadyAwarded);
  const siblings = open.filter((s) => s.type === 'SIBLING').length;
  const staff = open.filter((s) => s.type === 'STAFF_CHILD').length;

  const awardAll = async () => {
    setMessage(null);
    try {
      const r = await awardMany.mutateAsync(open.map((s) => ({ studentId: s.studentId, policyId: s.policyId })));
      setMessage(`${r.done.length} concession${r.done.length === 1 ? '' : 's'} awarded${r.skipped.length ? `. ${r.skipped.length} skipped: ${r.skipped[0]!.message}` : '.'}`);
    } catch (e) {
      setMessage(messageFor(e));
    }
  };

  return (
    <div className="space-y-4">
      <TabIntro title="Concessions" need="optional">
        {CONCESSIONS_INTRO}
      </TabIntro>

      <Can permission="finance:concession:manage">
        <Card aria-label="Suggested concessions">
          <CardHeader>
            <HelpHeading title="Suggested" help={<p>Found from the parent links in Students: brothers and sisters in the school, and children of staff. Check each, or award them all at once.</p>} />
            <Button disabled={open.length === 0} onClick={() => void awardAll()} loading={awardMany.isPending} loadingText="Awarding…">
              <Gift /> Award All Suggested
            </Button>
          </CardHeader>
          {suggestions.isLoading && <Skeleton className="h-16" role="status" aria-label="Loading" />}
          {suggestions.isError && <ErrorState error={suggestions.error} onRetry={() => void suggestions.refetch()} retrying={suggestions.isFetching} />}
          {suggestions.data && (
            <>
              <p className="text-[15px]" aria-live="polite">
                {open.length === 0 ? 'No new concessions to suggest right now.' : `${siblings} sibling discount${siblings === 1 ? '' : 's'} and ${staff} staff-child discount${staff === 1 ? '' : 's'} found.`}
              </p>
              <ul className="mt-2 divide-y divide-line">
                {open.map((s) => (
                  <li key={`${s.studentId}-${s.policyId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <b>{s.studentName}</b> <span className="text-muted">· {s.policyName} · {s.reason}</span>
                    </span>
                    <Button size="sm" variant="outline" onClick={() => setReviewing(s)} aria-label={`Review ${s.studentName}`}>
                      Review
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {message && (
            <Alert tone="success" className="mt-3">
              {message}
            </Alert>
          )}
        </Card>
      </Can>

      <Card>
        <CardHeader>
          <HelpHeading title="Concession rules" help={TIP_CONCESSION_VS_PAYMENT} helpLabel="About concessions and payments" />
          <Can permission="finance:concession:manage">
            <Button variant="outline" onClick={() => setPolicy('new')}>
              <Plus /> New Rule
            </Button>
          </Can>
        </CardHeader>
        {policies.isLoading && <Skeleton className="h-20" />}
        {policies.isError && <ErrorState error={policies.error} onRetry={() => void policies.refetch()} retrying={policies.isFetching} />}
        {policies.data?.length === 0 && <EmptyState title="No concession rules yet" description="A rule says who gets a discount, how much, and on which fees. Add a Sibling rule to start." />}
        <ul className="divide-y divide-line" aria-label="Concession rules">
          {policies.data?.map((p) => (
            <li key={p.policyId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {p.name} <span className="font-normal text-muted">· {CONCESSION_TYPE_LABELS[p.type]}</span>
                </p>
                <p className="text-[13px] text-muted">
                  {valueText(p.valueType, p.value)} · {p.stackMode === 'STACK' ? 'adds to other discounts' : 'highest discount wins'}
                  {p.capPercentBps ? ` · at most ${bpsToPercentText(p.capPercentBps)}% off` : ''}
                  {p.validTo ? ` · until ${formatDateOnly(p.validTo)}` : ''}
                </p>
              </div>
              {p.needsEvidence && <Badge tone="neutral">Needs a document</Badge>}
              {p.needsApproval && <Badge tone="sun">Needs approval</Badge>}
              <FinanceStatusPill status={p.status} />
              <Can permission="finance:concession:manage">
                <Button size="sm" variant="outline" onClick={() => setPolicy(p)} aria-label={`Edit ${p.name}`}>
                  <Pencil /> Edit
                </Button>
              </Can>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Awards" help={<p>An award gives one student a concession. A discount is not a payment. After bills are issued, an approved award makes a credit note.</p>} />
          <div className="flex flex-wrap gap-2">
            <ComboboxField
              label="Show"
              containerClassName="w-44"
              value={status}
              onChange={(v) => setStatus(v as typeof status)}
              options={[
                { value: '', label: 'All awards' },
                { value: 'PENDING', label: 'Waiting for approval' },
                { value: 'APPROVED', label: 'Approved' },
              ]}
              searchPlaceholder="Search…"
            />
            <Can permission="finance:concession:manage">
              <Button className="self-end" onClick={() => setAwarding(true)}>
                <Plus /> Add Concession
              </Button>
            </Can>
          </div>
        </CardHeader>
        {awards.isLoading && <Skeleton className="h-20" />}
        {awards.isError && <ErrorState error={awards.error} onRetry={() => void awards.refetch()} retrying={awards.isFetching} />}
        {awards.data?.items.length === 0 && <p className="text-sm text-muted">No awards yet.</p>}
        <ul className="divide-y divide-line" aria-label="Awards">
          {awards.data?.items.map((a) => (
            <li key={a.awardId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{a.studentName}</p>
                <p className="text-[13px] text-muted">
                  {a.policyName} · {valueText(a.valueType, a.value)}
                  {a.reason ? ` · ${a.reason}` : ''}
                </p>
              </div>
              <FinanceStatusPill status={a.status} />
              {a.status === 'PENDING' && (
                <Can permission="finance:concession:approve">
                  <Button size="sm" onClick={() => setDeciding({ award: a, action: 'approve' })} aria-label={`Approve ${a.studentName}`}>
                    Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDeciding({ award: a, action: 'reject' })} aria-label={`Reject ${a.studentName}`}>
                    Reject
                  </Button>
                </Can>
              )}
              {a.status === 'APPROVED' && (
                <Can permission="finance:concession:manage">
                  <Button size="sm" variant="outline" onClick={() => setDeciding({ award: a, action: 'end' })} aria-label={`End the concession for ${a.studentName}`}>
                    End
                  </Button>
                </Can>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <PolicyDrawer policy={policy} onClose={() => setPolicy(null)} />
      <AwardModal open={awarding} onClose={() => setAwarding(false)} />
      <ReviewModal suggestion={reviewing} onClose={() => setReviewing(null)} />
      <DecideDialog decision={deciding} onClose={() => setDeciding(null)} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── a rule

function PolicyDrawer({ policy, onClose }: { policy: ConcessionPolicyDTO | 'new' | null; onClose: () => void }) {
  return (
    <Drawer open={policy !== null} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title={policy === 'new' ? 'New concession rule' : 'Concession rule'} description="Who gets a discount, how much, and on which fees.">
        {policy && <PolicyForm key={policy === 'new' ? 'new' : policy.policyId} policy={policy === 'new' ? null : policy} onClose={onClose} />}
      </DrawerContent>
    </Drawer>
  );
}

function PolicyForm({ policy, onClose }: { policy: ConcessionPolicyDTO | null; onClose: () => void }) {
  const heads = useFeeHeads();
  const [name, setName] = useState(policy?.name ?? '');
  const [type, setType] = useState<ConcessionType>(policy?.type ?? 'SIBLING');
  const [valueType, setValueType] = useState<ConcessionValueType>(policy?.valueType ?? 'PERCENT');
  const [percent, setPercent] = useState(policy && policy.valueType === 'PERCENT' ? bpsToPercentText(policy.value) : '');
  const [fixed, setFixed] = useState<number | null>(policy && policy.valueType === 'FIXED' ? policy.value : null);
  const [headIds, setHeadIds] = useState<string[]>(policy?.feeHeadIds ?? []);
  const [stackMode, setStackMode] = useState<StackMode>(policy?.stackMode ?? 'HIGHEST_WINS');
  const [cap, setCap] = useState(policy?.capPercentBps ? bpsToPercentText(policy.capPercentBps) : '');
  const [validFrom, setValidFrom] = useState(policy?.validFrom ?? '');
  const [validTo, setValidTo] = useState(policy?.validTo ?? '');
  const [evidence, setEvidence] = useState(policy?.needsEvidence ?? false);
  const [approval, setApproval] = useState(policy?.needsApproval ?? false);
  const [active, setActive] = useState(policy ? policy.status === 'ACTIVE' : true);
  const [error, setError] = useState<string | null>(null);
  const save = useFinanceMutation((body: Record<string, unknown>) => (policy ? financeApi.updateConcessionPolicy(policy.policyId, body) : financeApi.createConcessionPolicy(body)), { success: 'Rule saved.', quiet: true });

  const value = valueType === 'PERCENT' ? percentTextToBps(percent) : fixed;
  const capBps = cap.trim() === '' ? null : percentTextToBps(cap);
  const ready = name.trim() !== '' && value !== null && value > 0 && (valueType !== 'PERCENT' || value <= 10_000) && (cap.trim() === '' || capBps !== null);

  const submit = async () => {
    setError(null);
    const common = { name: name.trim(), feeHeadIds: headIds, stackMode, capPercentBps: capBps, validFrom: validFrom || null, validTo: validTo || null, needsEvidence: evidence, needsApproval: approval };
    try {
      await save.mutateAsync(policy ? { ...common, value, status: active ? 'ACTIVE' : 'INACTIVE' } : { ...common, type, valueType, value });
      onClose();
    } catch (e) {
      setError(messageFor(e));
    }
  };

  return (
    <>
      <DrawerBody className="space-y-4">
        <TextField label="Rule name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Sibling discount." maxLength={100} />
        {!policy && (
          <div className="grid gap-3 sm:grid-cols-2">
            <ComboboxField label="Kind" value={type} onChange={(v) => setType(v as ConcessionType)} options={CONCESSION_TYPES.map((t) => ({ value: t, label: CONCESSION_TYPE_LABELS[t] ?? t }))} searchPlaceholder="Search…" />
            <ComboboxField label="Discount is" value={valueType} onChange={(v) => setValueType(v as ConcessionValueType)} options={CONCESSION_VALUE_TYPES.map((t) => ({ value: t, label: t === 'PERCENT' ? 'A percentage' : 'A fixed amount' }))} searchPlaceholder="Search…" />
          </div>
        )}
        {valueType === 'PERCENT' ? (
          <TextField label="Percentage off" required value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" hint="Example: 10 for 10% off." />
        ) : (
          <MoneyField label="Amount off each fee" required value={fixed} onChange={setFixed} hint="Taken off every covered fee, every time it is billed." />
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Which fees?</legend>
          <p className="text-[13px] text-muted">Leave all unticked to cover every fee.</p>
          <div className="flex flex-wrap gap-2">
            {(heads.data ?? []).filter((h) => h.status === 'ACTIVE').map((h) => {
              const on = headIds.includes(h.feeHeadId);
              return (
                <label key={h.feeHeadId} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-pill border px-3 text-sm ${on ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line bg-white'}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={(e) => setHeadIds(e.target.checked ? [...headIds, h.feeHeadId] : headIds.filter((i) => i !== h.feeHeadId))} />
                  {h.name}
                </label>
              );
            })}
          </div>
        </fieldset>
        <ComboboxField
          label="If a student has more than one discount"
          labelAside={<InfoTip label="About stacking">{TIP_STACK}</InfoTip>}
          value={stackMode}
          onChange={(v) => setStackMode(v as StackMode)}
          options={STACK_MODES.map((m) => ({ value: m, label: m === 'STACK' ? 'Add them together' : 'Only the highest wins' }))}
          searchPlaceholder="Search…"
        />
        <TextField label="Most that can be taken off a fee (%)" value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" hint="Optional. Example: 50 means never more than half." />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Starts on" type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} hint="Optional." />
          <TextField label="Ends on" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} hint="Optional." />
        </div>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={evidence} onChange={(e) => setEvidence(e.target.checked)} /> A proof document is needed
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Every award needs approval
        </label>
        {policy && (
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} /> Switched on
          </label>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ready} loading={save.isPending} loadingText="Saving…" onClick={() => void submit()}>
          Save Rule
        </Button>
      </DrawerFooter>
    </>
  );
}

// ───────────────────────────────────────────────────────────── award, review, decide

function AwardModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Add a concession" description="Give one student a concession from a rule.">
      {open && <AwardForm onClose={onClose} />}
    </Modal>
  );
}

function AwardForm({ onClose }: { onClose: () => void }) {
  const { can } = useAuth();
  const policies = useConcessionPolicies();
  const [student, setStudent] = useState<PickedStudent | null>(null);
  const [policyId, setPolicyId] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const policy = policies.data?.find((p) => p.policyId === policyId);
  const docs = useStudentDocuments(student?.studentId, !!student && !!policy?.needsEvidence && can('student:view'));
  const save = useFinanceMutation((body: Record<string, unknown>) => financeApi.awardConcession(body), { success: 'Concession added.', quiet: true });
  const ready = !!student && !!policy && (!policy.needsEvidence || evidenceId !== '');
  return (
    <div className="space-y-4">
      <StudentPicker value={student} onChange={setStudent} />
      <ComboboxField
        label="Rule"
        required
        value={policyId}
        onChange={setPolicyId}
        placeholder="Choose…"
        searchPlaceholder="Search rules…"
        options={(policies.data ?? []).filter((p) => p.status === 'ACTIVE').map((p) => ({ value: p.policyId, label: p.name, hint: valueText(p.valueType, p.value) }))}
      />
      {policy?.needsEvidence &&
        (can('student:view') ? (
          <ComboboxField
            label="Proof document"
            required
            value={evidenceId}
            onChange={setEvidenceId}
            placeholder={student ? 'Choose a document…' : 'Choose a student first'}
            searchPlaceholder="Search documents…"
            options={(docs.data?.items ?? []).map((d) => ({ value: d.documentId, label: d.displayName }))}
            hint="Upload the proof in the student’s Documents first. Then pick it here."
          />
        ) : (
          <Alert tone="warning" title="This rule needs a proof document">
            Ask the school office to upload the proof in the student’s Documents. Then you can add the concession.
          </Alert>
        ))}
      <TextareaField label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} hint="Optional. Example: Second child in the school." maxLength={300} />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={!ready}
          loading={save.isPending}
          loadingText="Saving…"
          onClick={async () => {
            setError(null);
            try {
              await save.mutateAsync({ studentId: student!.studentId, policyId, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(evidenceId ? { evidenceFileId: evidenceId } : {}) });
              onClose();
            } catch (e) {
              setError(messageFor(e));
            }
          }}
        >
          Add Concession
        </Button>
      </div>
    </div>
  );
}

function ReviewModal({ suggestion, onClose }: { suggestion: ConcessionSuggestionDTO | null; onClose: () => void }) {
  const award = useFinanceMutation((s: ConcessionSuggestionDTO) => financeApi.awardConcession({ studentId: s.studentId, policyId: s.policyId, reason: s.reason }), { success: 'Concession awarded.' });
  return (
    <Modal open={suggestion !== null} onOpenChange={(o) => !o && onClose()} title="Review this concession" description={suggestion ? `${suggestion.studentName} · ${suggestion.policyName}` : undefined}>
      {suggestion && (
        <div className="space-y-4">
          <p className="text-sm">{suggestion.reason}</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Not Now
            </Button>
            <Button loading={award.isPending} loadingText="Awarding…" onClick={() => award.mutate(suggestion, { onSuccess: onClose })}>
              Award Concession
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** What an award is worth each month: the covered monthly fees of the student's plan, times the rate. */
function MonthlyEffect({ award }: { award: ConcessionAwardDTO }) {
  const ctx = useStudentContext();
  const policies = useConcessionPolicies();
  const account = useStudentAccount(award.studentId);
  const plans = useFeePlans(ctx.sessionId);
  const policy = policies.data?.find((p) => p.policyId === award.policyId);
  const version = plans.data?.flatMap((p) => [p.publishedVersion, p.latestVersion]).find((v) => v?.versionId === account.data?.assignment?.planVersionId);
  if (!policy || !version) return <p className="text-sm text-muted">This student has no fee plan yet, so the monthly effect cannot be shown.</p>;
  const covered = version.items.filter((i) => i.frequency === 'MONTHLY' && !i.isOptional && (policy.feeHeadIds.length === 0 || policy.feeHeadIds.includes(i.feeHeadId)));
  const perMonth = covered.reduce((s, i) => s + (award.valueType === 'PERCENT' ? Math.round((i.amountPaise * award.value) / 10_000) : Math.min(award.value, i.amountPaise)), 0);
  return (
    <p className="rounded-xl bg-brand-soft/60 px-3 py-2 text-sm" data-testid="monthly-effect">
      {covered.length === 0 ? 'No monthly fee is covered by this rule.' : <>About <b>{formatMoney(perMonth)}</b> less to pay every month on {covered.map((c) => c.feeHeadName).join(', ')}.</>}
    </p>
  );
}

function DecideDialog({ decision, onClose }: { decision: { award: ConcessionAwardDTO; action: 'approve' | 'reject' | 'end' } | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const run = useFinanceMutation((v: { id: string; action: 'approve' | 'reject' | 'end'; reason: string }) => financeApi.decideAward(v.id, v.action, v.reason || undefined), { quiet: true });
  const verb = decision?.action === 'approve' ? 'Approve' : decision?.action === 'reject' ? 'Reject' : 'End';
  return (
    <ConfirmDialog
      open={decision !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          onClose();
        }
      }}
      title={`${verb} this concession?`}
      description={decision ? `${decision.award.studentName} · ${decision.award.policyName}` : ''}
      confirmLabel={`${verb} Concession`}
      loadingLabel="Saving…"
      tone={decision?.action === 'reject' ? 'danger' : 'default'}
      onConfirm={async () => {
        await run.mutateAsync({ id: decision!.award.awardId, action: decision!.action, reason: reason.trim() });
        setReason('');
      }}
    >
      {decision && decision.action === 'approve' && <MonthlyEffect award={decision.award} />}
      {decision && decision.action !== 'approve' && <TextareaField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Optional." maxLength={300} />}
    </ConfirmDialog>
  );
}
