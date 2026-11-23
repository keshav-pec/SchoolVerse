import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Users } from 'lucide-react';
import type { AssignmentRowDTO, BulkAssignResultDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading } from '@/components/sv/help';
import { ExceptionHeader } from '@/components/finance/exception-header';
import { Money } from '@/components/finance/money';
import { messageFor } from '@/lib/errors';
import { formatMoneyShort } from '@/lib/money';
import { useClassOfferings } from '../academic/api';
import { useStudentContext } from '../students/context';
import { FIN, financeApi, useFinanceMutation } from './api';
import { REASON_TEXT } from './help-copy';

/**
 * Smart assignment: "Class VIII: 164 eligible · 157 ready · 7 need review", with one button that assigns every ready student.
 * Only the students who need a decision are listed, each with the reason in words and the actions Choose Plan or Skip.
 */
export function AssignmentPanel() {
  const ctx = useStudentContext();
  const offerings = useClassOfferings(ctx.sessionId, ctx.locationId);
  const [classId, setClassId] = useState('');
  const [result, setResult] = useState<BulkAssignResultDTO | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const params = { sessionId: ctx.sessionId!, locationId: ctx.locationId!, ...(classId ? { classId } : {}) };
  const rec = useQuery({
    queryKey: [...FIN, 'recommend', params],
    queryFn: () => financeApi.recommend(params),
    enabled: !!ctx.sessionId && !!ctx.locationId,
  });
  const assign = useFinanceMutation((items?: { studentId: string; planVersionId?: string }[]) => financeApi.bulkAssign({ ...params, ...(items ? { items } : {}) }), { quiet: true });
  const [error, setError] = useState<string | null>(null);

  const data = rec.data;
  const className = classId ? (offerings.data?.find((o) => o.classId === classId)?.displayName ?? 'This class') : 'All classes';
  const review = (data?.rows ?? []).filter((r) => r.status === 'PLAN_CONFLICT' || r.status === 'NO_PLAN').filter((r) => !skipped.includes(r.studentId));

  const run = async (items?: { studentId: string; planVersionId?: string }[]) => {
    setError(null);
    try {
      const res = await assign.mutateAsync(items);
      setResult(res);
    } catch (e) {
      setError(messageFor(e));
    }
  };

  return (
    <Card aria-label="Assign fee plans">
      <CardHeader>
        <HelpHeading
          title="Assign fee plans"
          help={<p>Students are matched to the published plan for their class. Only the students that need a decision are listed below. Everyone else is assigned in one click.</p>}
        />
        <Combobox
          aria-label="Class"
          className="h-9 w-52"
          value={classId}
          onChange={(v) => {
            setClassId(v);
            setResult(null);
          }}
          options={[{ value: '', label: 'All classes' }, ...(offerings.data ?? []).map((o) => ({ value: o.classId, label: o.displayName }))]}
          searchPlaceholder="Search classes…"
        />
      </CardHeader>

      {rec.isLoading && <Skeleton className="h-16" role="status" aria-label="Loading" />}
      {rec.isError && <ErrorState error={rec.error} onRetry={() => void rec.refetch()} retrying={rec.isFetching} />}
      {data && (
        <div className="space-y-3">
          <p className="text-[15px]" aria-live="polite">
            <b>{className}:</b> {data.totals.eligible} eligible · {data.totals.ready} ready · {data.totals.needReview} need review
            {data.totals.alreadyAssigned > 0 && <span className="text-muted"> · {data.totals.alreadyAssigned} already on a plan</span>}
          </p>
          <ExceptionHeader
            ready={data.totals.ready}
            attention={data.totals.needReview}
            readyWord="ready to assign"
            totalPaise={data.expectedPaise}
            action={
              <Can permission="finance:fee_plan:manage">
                <Button onClick={() => void run()} disabled={data.totals.ready === 0} loading={assign.isPending} loadingText="Assigning…">
                  <Users /> {`Assign ${data.totals.ready} ${data.totals.ready === 1 ? 'Student' : 'Students'}`}
                </Button>
              </Can>
            }
          />
          {data.totals.ready > 0 && <p className="text-[13px] text-muted">Expected this year from these students: {formatMoneyShort(data.expectedPaise)}</p>}
          {error && <Alert tone="danger">{error}</Alert>}
          {result && (
            <Alert tone={result.skipped ? 'warning' : 'success'} title={`Done ${result.done}${result.skipped ? `. ${result.skipped} need your decision` : ''}`}>
              <span className="flex items-start gap-1.5">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                Expected this year from the new assignments: <Money paise={result.expectedPaise} strong />.
              </span>
            </Alert>
          )}
          {review.length > 0 && (
            <section aria-label="Students that need a decision">
              <h3 className="mb-1 text-sm font-bold">Needs your decision</h3>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {review.map((r) => (
                  <ReviewRow key={r.studentId} row={r} busy={assign.isPending} onChoose={(planVersionId) => void run([{ studentId: r.studentId, planVersionId }])} onSkip={() => setSkipped((s) => [...s, r.studentId])} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Card>
  );
}

function ReviewRow({ row, busy, onChoose, onSkip }: { row: AssignmentRowDTO; busy: boolean; onChoose: (planVersionId: string) => void; onSkip: () => void }) {
  const [plan, setPlan] = useState(row.candidatePlans[0]?.versionId ?? '');
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {row.studentName} <span className="font-normal text-muted">· {row.className}</span>
        </p>
        <p className="text-[13px] text-muted">{row.status === 'PLAN_CONFLICT' ? REASON_TEXT.PLAN_CONFLICT : REASON_TEXT.NO_PLAN}</p>
      </div>
      <Can permission="finance:fee_plan:manage">
        {row.candidatePlans.length > 0 && (
          <>
            <Combobox
              aria-label={`Plan for ${row.studentName}`}
              className="h-9 w-56"
              value={plan}
              onChange={setPlan}
              options={row.candidatePlans.map((p) => ({ value: p.versionId, label: p.planName }))}
              searchPlaceholder="Search plans…"
            />
            <Button size="sm" disabled={!plan || busy} onClick={() => onChoose(plan)} aria-label={`Choose plan for ${row.studentName}`}>
              Choose Plan
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={onSkip} aria-label={`Skip ${row.studentName}`}>
          Skip
        </Button>
      </Can>
    </li>
  );
}
