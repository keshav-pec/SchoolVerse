import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PROMOTION_DECISION_LABELS, type BulkPromotionResultDTO, type PromotionDecision, type PromotionRowDTO } from '@shared';
import { ArrowRight, CalendarRange, ChevronDown, ChevronUp, CircleAlert, CircleCheck, GraduationCap, Rocket, Save } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { useSections } from '../academic/api';
import { useStudentMutation } from './api';
import { useStudentContext } from './context';
import { PROMOTION_INTRO } from './help-copy';
import { usePromotionReadiness } from './lifecycle-api';

interface Choice {
  decision: PromotionDecision | '';
  sectionId: string;
}

const n = (value: number) => value.toLocaleString('en-IN');

/** Students who already have a place next year are done, not "needing a look". */
const alreadyPromoted = (row: PromotionRowDTO) => row.reasons.length > 0 && row.reasons.every((r) => r.code === 'ALREADY_PROMOTED');

/** "Promote to Class IX · IX-B", or "Finished school" for the last class. */
function nextText(row: PromotionRowDTO) {
  if (row.isFinalClass) return 'Finished school';
  if (!row.nextClassName) return 'No class next year';
  return `${row.nextClassName}${row.suggestedSectionLabel ? ` · ${row.suggestedSectionLabel}` : ''}`;
}

function ReviewRow({ row, choice, onChange }: { row: PromotionRowDTO; choice: Choice; onChange: (c: Choice) => void }) {
  const sections = useSections(row.nextClassOfferingId ?? undefined, choice.decision === 'PROMOTE' && Boolean(row.nextClassOfferingId));
  const decisions: PromotionDecision[] = row.isFinalClass ? ['PASSED_OUT', 'REPEAT', 'LEAVING', 'HOLD'] : ['PROMOTE', 'REPEAT', 'LEAVING', 'HOLD'];
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="review-row">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm font-semibold">
          <Link to={`/students/${row.studentId}`} className="text-ink hover:text-brand hover:underline">
            {row.fullName}
          </Link>
          <span className="ml-2 font-normal text-muted">
            {row.fromClass}
            {row.fromSection ? `-${row.fromSection}` : ''}
          </span>
        </p>
        <p className="text-[13px] text-muted">{row.reasons.map((r) => r.message).join(' ')}</p>
      </div>
      <Combobox
        aria-label={`What happens to ${row.fullName}`}
        className="h-9 w-44"
        value={choice.decision}
        onChange={(v) => onChange({ decision: v as PromotionDecision, sectionId: '' })}
        options={decisions.map((d) => ({ value: d, label: PROMOTION_DECISION_LABELS[d], hint: d === 'PROMOTE' && !row.nextClassOfferingId ? 'No class next year' : undefined, disabled: d === 'PROMOTE' && !row.nextClassOfferingId }))}
        placeholder="Decide…"
        searchPlaceholder="Search…"
      />
      {choice.decision === 'PROMOTE' && row.nextClassOfferingId && (
        <Combobox
          aria-label={`Section for ${row.fullName}`}
          className="h-9 w-40"
          value={choice.sectionId}
          onChange={(v) => onChange({ ...choice, sectionId: v })}
          options={[{ value: '', label: 'Suggest one' }, ...(sections.data ?? []).filter((s) => s.status === 'ACTIVE').map((s) => ({ value: s.sectionOfferingId, label: s.displayName }))]}
          searchPlaceholder="Search sections…"
        />
      )}
    </li>
  );
}

function ResultCard({ result, onClose }: { result: BulkPromotionResultDTO; onClose: () => void }) {
  const failed = result.rows.filter((r) => r.status === 'FAILED');
  const skipped = result.rows.filter((r) => r.status === 'SKIPPED');
  return (
    <Card className="space-y-3" aria-label="Promotion result">
      <Alert tone={result.failed > 0 ? 'warning' : 'success'} title="Promotion finished">
        {n(result.done)} done · {n(result.skipped)} skipped · {n(result.failed)} failed. Running it again is safe: nobody is promoted twice.
      </Alert>
      {failed.length > 0 && (
        <section aria-label="Failed">
          <h3 className="mb-1 text-sm font-bold">Could not be promoted</h3>
          <ul className="divide-y divide-line">
            {failed.map((r) => (
              <li key={r.studentId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <CircleAlert className="size-4 text-danger" aria-hidden="true" />
                <Link to={`/students/${r.studentId}`} className="font-semibold hover:text-brand hover:underline">
                  {r.fullName}
                </Link>
                <span className="text-muted">{r.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {skipped.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">Skipped ({skipped.length})</summary>
          <ul className="mt-1 space-y-1 text-sm text-muted">
            {skipped.map((r) => (
              <li key={r.studentId}>
                {r.fullName}: {r.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Button variant="ghost" size="sm" onClick={onClose}>
        Close
      </Button>
    </Card>
  );
}

/** `/students/promotion`: exception-first. Students who need a look come first with the reason; the ready ones are promoted in one go. */
export function PromotionPage() {
  const ctx = useStudentContext();
  const from = ctx.session;
  const later = useMemo(() => (from ? ctx.sessions.filter((s) => s.startDate > from.startDate).sort((a, b) => a.startDate.localeCompare(b.startDate)) : []), [ctx.sessions, from]);
  const [toId, setToId] = useState('');
  const to = later.find((s) => s.academicSessionId === toId) ?? later[0];
  const q = usePromotionReadiness({ fromSessionId: from?.academicSessionId, toSessionId: to?.academicSessionId, locationId: ctx.locationId });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [showReady, setShowReady] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<BulkPromotionResultDTO | null>(null);

  const scope = { fromSessionId: from?.academicSessionId, toSessionId: to?.academicSessionId };
  const promoteReady = useStudentMutation((_: void) => api.post<BulkPromotionResultDTO>('/promotions/bulk', { ...scope, locationId: ctx.locationId, readyOnly: true }), { quiet: true });
  const saveDecisions = useStudentMutation((decisions: object[]) => api.post<BulkPromotionResultDTO>('/promotions/bulk', { ...scope, locationId: ctx.locationId, decisions }), { quiet: true });

  const data = q.data;
  const promotedRows = useMemo(() => (data?.reviewRows ?? []).filter(alreadyPromoted), [data]);
  const reviewRows = useMemo(() => (data?.reviewRows ?? []).filter((r) => !alreadyPromoted(r)), [data]);
  const groups = useMemo(() => {
    const map = new Map<string, { title: string; rows: PromotionRowDTO[] }>();
    for (const row of reviewRows) {
      const first = row.reasons[0];
      const key = first?.code ?? 'OTHER';
      if (!map.has(key)) map.set(key, { title: first?.message ?? 'Needs a look', rows: [] });
      map.get(key)!.rows.push(row);
    }
    return [...map.values()];
  }, [reviewRows]);
  const decided = Object.entries(choices).filter(([, c]) => c.decision);

  const toWarning = to && to.status !== 'PUBLISHED' && to.status !== 'ACTIVE' ? `${to.code || to.name} is still a draft. Publish it in Academic Setup before promoting.` : null;

  return (
    <>
      <PageHeader eyebrow="Students" title="Promotion" description="Move students to next year’s class." />
      <TabIntro title="About promotion" className="mb-4">
        {PROMOTION_INTRO}
      </TabIntro>

      <Card className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 text-sm">
          <CalendarRange className="size-4 text-brand" aria-hidden="true" />
          <span className="text-muted">From</span>
          <span className="font-semibold">{from ? from.code || from.name : '—'}</span>
          <ArrowRight className="size-4 text-muted" aria-hidden="true" />
        </div>
        <label htmlFor="promotion-to-year" className="text-sm font-semibold text-ink">
          To school year
        </label>
        <div className="w-48">
          <Combobox
            id="promotion-to-year"
            value={to?.academicSessionId ?? ''}
            onChange={setToId}
            options={later.map((s) => ({ value: s.academicSessionId, label: s.code || s.name, hint: s.status === 'DRAFT' ? 'Draft' : s.status === 'PUBLISHED' ? 'Published' : undefined }))}
            placeholder="No later year"
            searchPlaceholder="Search years…"
          />
        </div>
      </Card>

      {!to ? (
        <Card>
          <EmptyState
            illustration={<GraduationCap className="size-12 text-brand" aria-hidden="true" />}
            title="No next school year yet"
            description="Create next year in Academic Setup (copy this year to save time) and publish it. Then come back to promote."
            action={
              <Button asChild variant="outline">
                <Link to="/academics">Go To Academic Setup</Link>
              </Button>
            }
          />
        </Card>
      ) : q.isLoading || ctx.loading ? (
        <div className="space-y-4" role="status" aria-label="Checking students">
          <Skeleton className="h-24 rounded-card" />
          <Skeleton className="h-48 rounded-card" />
        </div>
      ) : q.isError || !data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-4">
          {toWarning && <Alert tone="warning">{toWarning}</Alert>}
          {result && <ResultCard result={result} onClose={() => setResult(null)} />}

          <Card className="flex flex-wrap items-center gap-4" aria-label="Promotion summary">
            <p className="flex-1 text-[15px]" data-testid="promotion-summary">
              {n(data.checked)} {data.checked === 1 ? 'student' : 'students'} checked. <b className="text-success">{n(data.ready)} ready.</b> <b className={reviewRows.length > 0 ? 'text-warning' : 'text-ink'}>{n(reviewRows.length)} need a look.</b>
              {promotedRows.length > 0 && <span className="text-muted"> {n(promotedRows.length)} already promoted.</span>}
            </p>
            <Button onClick={() => setConfirming(true)} disabled={data.ready === 0 || Boolean(toWarning)} title={data.ready === 0 ? 'Nobody is ready yet' : undefined}>
              <Rocket /> Promote All Ready Students
            </Button>
          </Card>

          <Card className="p-0" aria-label="Needs a look">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              <h2 className="flex flex-1 items-center gap-2 text-base font-bold">
                Needs a look <Badge tone={reviewRows.length > 0 ? 'warning' : 'success'}>{reviewRows.length}</Badge>
              </h2>
              {decided.length > 0 && (
                <Button
                  size="sm"
                  loading={saveDecisions.isPending}
                  loadingText="Saving…"
                  onClick={async () => {
                    const decisions = decided.map(([studentId, c]) => ({ studentId, decision: c.decision, ...(c.sectionId ? { sectionId: c.sectionId } : {}) }));
                    const r = await saveDecisions.mutateAsync(decisions).catch(() => null);
                    if (r) {
                      setResult(r);
                      setChoices({});
                    }
                  }}
                >
                  <Save /> Save {decided.length} Decision{decided.length === 1 ? '' : 's'}
                </Button>
              )}
            </div>
            {groups.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
                <CircleCheck className="size-4 text-success" aria-hidden="true" /> Nobody needs a look. Every student is ready.
              </p>
            ) : (
              groups.map((g) => (
                <section key={g.title} aria-label={g.title}>
                  <h3 className="bg-canvas px-4 py-2 text-[13px] font-bold text-muted">
                    {g.title} ({g.rows.length})
                  </h3>
                  <ul className="divide-y divide-line">
                    {g.rows.map((row) => (
                      <ReviewRow key={row.studentId} row={row} choice={choices[row.studentId] ?? { decision: '', sectionId: '' }} onChange={(c) => setChoices((prev) => ({ ...prev, [row.studentId]: c }))} />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </Card>

          <Card className="p-0" aria-label="Ready">
            <button type="button" className="flex w-full items-center gap-2 px-4 py-3 text-left" onClick={() => setShowReady((v) => !v)} aria-expanded={showReady}>
              <span className="flex flex-1 items-center gap-2 text-base font-bold">
                Ready <Badge tone="success">{data.ready}</Badge>
              </span>
              <span className="text-sm font-semibold text-brand">{showReady ? 'Hide' : 'Review'}</span>
              {showReady ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
            </button>
            {showReady && (
              <ul className="divide-y divide-line border-t border-line">
                {data.readyRows.map((row) => (
                  <li key={row.studentId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1 font-semibold">{row.fullName}</span>
                    <span className="text-muted">
                      {row.fromClass}
                      {row.fromSection ? `-${row.fromSection}` : ''}
                    </span>
                    <ArrowRight className="size-4 text-muted" aria-label="to" />
                    <span className={row.isFinalClass ? 'font-semibold text-brand' : 'font-semibold'}>{nextText(row)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {confirming && data && to && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          icon={<Rocket className="size-5" />}
          title={`Promote ${n(data.ready)} ready students?`}
          description={
            <>
              <p>
                They move to their next class in {to.code || to.name} at {ctx.location?.displayName}, with a section, a roll number and the required subjects. Students in the last class are marked “Finished school”.
              </p>
              <p className="mt-1">{reviewRows.length > 0 ? `${n(reviewRows.length)} students who need a look are not touched.` : ''} This year’s records are kept. Running it again is safe.</p>
            </>
          }
          confirmLabel="Promote Students"
          loadingLabel="Promoting…"
          onConfirm={async () => {
            if (!ctx.locationId) throw new FormProblem('Choose a campus at the top of the page first.');
            setResult(await promoteReady.mutateAsync());
          }}
        />
      )}
    </>
  );
}
