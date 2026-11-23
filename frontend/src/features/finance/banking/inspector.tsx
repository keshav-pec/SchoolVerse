import { useState } from 'react';
import { ArrowLeftRight, CircleCheck, Landmark, School } from 'lucide-react';
import type { MatchCandidateDTO, MatchDTO, ReconExceptionsDTO, StatementLineDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TextareaField } from '@/components/ui/field';
import { Modal } from '@/components/sv/modal';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { ErrorBanner } from '../error-banner';
import { bankApi } from '../ops-api';
import { todayLocal } from '../collect/shared';

export type ExceptionItem = ReconExceptionsDTO['groups'][number]['items'][number];

const CONFIDENCE: Record<string, { label: string; tone: 'success' | 'brand' | 'sun' | 'neutral' }> = {
  HIGH: { label: 'Very likely', tone: 'success' },
  MEDIUM: { label: 'Likely', tone: 'brand' },
  LOW: { label: 'Possible', tone: 'sun' },
  MANUAL: { label: 'Chosen by a person', tone: 'neutral' },
};

const lineAmount = (l: StatementLineDTO) => (l.creditPaise > 0 ? l.creditPaise : -l.debitPaise);

function Side({ title, Icon, children }: { title: string; Icon: typeof Landmark; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 flex-1 rounded-xl border border-line bg-white p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
        <Icon className="size-4" aria-hidden="true" /> {title}
      </p>
      {children}
    </section>
  );
}

function Candidate({ c, action }: { c: MatchCandidateDTO; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-canvas px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <b>{c.label}</b>
        <span className="block text-[13px] text-muted">
          {formatDateOnly(c.date)}
          {c.reference ? ` · ref ${c.reference}` : ''}
          {c.verified ? ' · checked' : ' · not checked yet'}
        </span>
      </span>
      <Money paise={c.amountPaise} strong />
      {action}
    </div>
  );
}

/**
 * The Reconciliation Inspector: the bank line on the left, the SchoolVerse record on the right, the confidence and its reasons in
 * words, other candidates, and every action that can settle the line. Anything that changes the books without a matching record
 * (Ignore, a match with a different total) needs a second person.
 */
export function Inspector({ item, bankAccountId, onClose }: { item: ExceptionItem; bankAccountId: string; onClose: () => void }) {
  const line = item.line;
  const match: MatchDTO | undefined = item.matches.find((m) => m.state === 'SUGGESTED') ?? item.matches[0];
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState('');
  const flow = useApprovalFlow();
  const confirm = useFinanceMutation((v: { matchId: string; verify: boolean }) => bankApi.confirm(v.matchId, v.verify ? { verify: true, seenOn: todayLocal() } : {}), { success: 'Matched.' });
  const pick = useFinanceMutation((v: { target: MatchCandidateDTO; approvalId?: string }) => bankApi.manualMatch({ bankAccountId, lineIds: [line.lineId], targets: [{ type: v.target.type, id: v.target.id }], reason: 'Picked in the inspector', ...(v.approvalId ? { approvalId: v.approvalId } : {}) }), { quiet: true, success: 'Matched.' });
  const charge = useFinanceMutation(() => bankApi.bankCharge(line.lineId), { success: 'Recorded as a bank charge.' });
  const interest = useFinanceMutation(() => bankApi.interest(line.lineId), { success: 'Recorded as bank interest.' });
  const ignore = useFinanceMutation((approvalId: string | undefined) => bankApi.ignore(line.lineId, { reason: reason.trim(), ...(approvalId ? { approvalId } : {}) }), { quiet: true, success: 'The line is set aside.' });
  const done = (p: Promise<unknown>) => p.then(onClose, () => undefined);
  const amount = lineAmount(line);
  const others = item.candidates.filter((c) => !match?.targets.some((t) => t.id === c.id));
  const error = confirm.error ?? charge.error ?? interest.error;

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Check this bank line" description={item.hint} className="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
          <Side title="Bank line" Icon={Landmark}>
            <p className="text-lg font-extrabold">
              <Money paise={amount} /> <span className="text-sm font-semibold text-muted">{amount >= 0 ? 'money in' : 'money out'}</span>
            </p>
            <p className="text-sm">{line.description || 'No description'}</p>
            <p className="text-[13px] text-muted">
              {formatDateOnly(line.date)}
              {line.reference ? ` · ref ${line.reference}` : ''}
            </p>
            <div className="mt-2">
              <FinanceStatusPill status={line.status} />
            </div>
          </Side>
          <ArrowLeftRight className="hidden size-5 shrink-0 self-center text-muted md:block" aria-hidden="true" />
          <Side title="SchoolVerse record" Icon={School}>
            {match ? (
              <div className="space-y-2">
                {match.targets.map((t) => (
                  <Candidate key={t.id} c={t} />
                ))}
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={CONFIDENCE[match.confidence]?.tone ?? 'neutral'}>{CONFIDENCE[match.confidence]?.label ?? match.confidence}</Badge>
                  <span data-testid="match-reasons">{match.reasons.join(', ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}</span>
                </p>
                <p className="text-[13px] text-muted">
                  Expected {formatMoney(match.targetsPaise)} · bank shows {formatMoney(match.linesPaise)}
                  {match.targetsPaise !== match.linesPaise && <b className="text-danger"> · differs by {formatMoney(Math.abs(match.linesPaise - match.targetsPaise))}</b>}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">No record looks like this line. Pick one below, or record it as a bank charge or interest.</p>
            )}
          </Side>
        </div>

        {match && (
          <div className="flex flex-wrap gap-2">
            {match.needsVerification ? (
              <Button loading={confirm.isPending} loadingText="Matching…" onClick={() => void done(confirm.mutateAsync({ matchId: match.matchId, verify: true }))}>
                <CircleCheck /> Verify And Match
              </Button>
            ) : (
              <Button loading={confirm.isPending} loadingText="Matching…" onClick={() => void done(confirm.mutateAsync({ matchId: match.matchId, verify: false }))}>
                <CircleCheck /> Confirm
              </Button>
            )}
            {match.needsVerification && <p className="self-center text-[13px] text-muted">The payment is not checked yet. Verify And Match checks it and matches it in one step.</p>}
          </div>
        )}

        {others.length > 0 && (
          <section aria-label="Other records" className="space-y-2">
            <h3 className="text-sm font-bold">{match ? 'Pick Another' : 'Records that could match'}</h3>
            {others.map((c) => (
              <Candidate
                key={c.id}
                c={c}
                action={
                  <Button size="sm" variant="outline" loading={pick.isPending && pick.variables?.target.id === c.id} loadingText="Matching…" onClick={() => void flow.run((approvalId) => pick.mutateAsync({ target: c, approvalId })).then((r) => r && onClose())}>
                    {flow.label('Pick This')}
                  </Button>
                }
              />
            ))}
          </section>
        )}

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {line.debitPaise > 0 && (
            <Button size="sm" variant="outline" loading={charge.isPending} loadingText="Saving…" onClick={() => void done(charge.mutateAsync(undefined))}>
              Record Bank Charge
            </Button>
          )}
          {line.creditPaise > 0 && (
            <Button size="sm" variant="outline" loading={interest.isPending} loadingText="Saving…" onClick={() => void done(interest.mutateAsync(undefined))}>
              Record Interest
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setIgnoring((v) => !v)} aria-expanded={ignoring}>
            Ignore (Needs Approval)
          </Button>
        </div>
        {ignoring && (
          <section aria-label="Ignore this line" className="space-y-2 rounded-xl border border-line p-3">
            <TextareaField label="Why can this line be set aside?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Bank reversed the same amount the next day." maxLength={300} />
            {flow.banner}
            <Button size="sm" variant="destructive" disabled={!reason.trim()} loading={ignore.isPending} loadingText="Saving…" onClick={() => void flow.run((approvalId) => ignore.mutateAsync(approvalId)).then((r) => r && onClose())}>
              {flow.label('Ignore Line')}
            </Button>
          </section>
        )}
        {flow.errorBox}
        {error && <ErrorBanner error={error} />}
        {!match && others.length === 0 && line.creditPaise > 0 && <Alert tone="info">Money came in that SchoolVerse does not know about. If a parent paid, ask them to report the payment, then match it here.</Alert>}
      </div>
    </Modal>
  );
}
