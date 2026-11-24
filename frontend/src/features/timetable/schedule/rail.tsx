import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { CoverageRowDTO, GridDTO, ScheduleAttentionDTO, SlotOptionDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfoTip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { TIPS } from '../help-copy';
import { useLessonActions } from './actions';
import { useRecommendedSlots } from './api';
import { useEditor } from './editor';

/** One subject with periods still to place, the best slot we found for it, and a one-click Place. */
function LeftRow({ row, canEdit }: { row: CoverageRowDTO; canEdit: boolean }) {
  const { versionId } = useEditor();
  const actions = useLessonActions();
  const [more, setMore] = useState(false);
  const target = row.kind === 'GROUP' ? { groupId: row.teachingGroupId ?? undefined } : { sectionId: row.sectionOfferingId ?? undefined, subjectOfferingId: row.subjectOfferingId };
  const rec = useRecommendedSlots(versionId, target, true);
  const place = (o: SlotOptionDTO) =>
    actions.add(`Add ${row.subjectName}`, { weekday: o.weekday, periodId: o.periodId, entryType: 'SUBJECT', subjectOfferingId: row.subjectOfferingId, ...(row.kind === 'GROUP' ? { teachingGroupId: row.teachingGroupId } : { sectionOfferingIds: [row.sectionOfferingId] }) });
  const options = rec.data ? [rec.data.recommended, ...rec.data.alternatives].filter((o): o is SlotOptionDTO => !!o) : [];
  return (
    <li className="space-y-2 rounded-xl border border-line bg-white p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="font-bold">{row.subjectName}</p>
        <span className="text-[13px] font-semibold text-warning">{row.left} left</span>
      </div>
      {rec.isLoading && <Skeleton className="h-9 rounded-lg" role="status" aria-label="Finding a slot" />}
      {rec.data?.recommended && (
        <div className="space-y-1">
          <p className="text-[13px]">
            <span className="font-semibold">{rec.data.recommended.label}</span>
            {rec.data.recommended.why[0] && <span className="block text-muted">{rec.data.recommended.why[0]}</span>}
          </p>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void place(rec.data!.recommended!)} aria-label={`Place ${row.subjectName} on ${rec.data.recommended.label}`}>
                Place
              </Button>
              {options.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => setMore((m) => !m)} aria-expanded={more}>
                  More Options
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {rec.data && !rec.data.recommended && <p className="text-[13px] text-muted">{rec.data.message ?? 'No free slot right now.'}</p>}
      {more && (
        <ul className="space-y-1" aria-label={`More options for ${row.subjectName}`}>
          {options.slice(1).map((o) => (
            <li key={`${o.weekday}-${o.periodId}`} className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-2 py-1.5 text-[13px]">
              <span>{o.label}</span>
              <Button size="sm" variant="outline" onClick={() => void place(o)}>
                Place
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The right-hand rail: what is left to place, what needs attention for this section, and how full each subject is. */
export function SmartRail({ grid, attention, sectionId, canEdit }: { grid: GridDTO; attention: ScheduleAttentionDTO | undefined; sectionId: string | undefined; canEdit: boolean }) {
  const rows = grid.coverage?.rows ?? [];
  const left = rows.filter((r) => r.left > 0);
  const mine = (attention?.groups ?? []).flatMap((g) => g.rows.filter((r) => (sectionId ? r.sectionOfferingId === sectionId : true)).map((r) => ({ ...r, group: g.label })));
  return (
    <Card className="space-y-3 p-4" aria-label="Smart Rail">
      {attention && (
        <Link to="/timetable/attention" className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2 text-sm font-semibold text-brand hover:underline">
          <span data-testid="progress-line">{attention.progress}</span>
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      )}
      <Tabs defaultValue="left">
        <TabsList aria-label="Rail sections">
          <TabsTrigger value="left">Left To Place{left.length > 0 ? ` (${left.length})` : ''}</TabsTrigger>
          <TabsTrigger value="attention">Needs Attention</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
        </TabsList>
        <TabsContent value="left" className="space-y-2">
          <p className="flex items-center gap-1.5 text-[13px] text-muted">
            Subjects with periods still to place <InfoTip label="About Left To Place">{TIPS.leftToPlace}</InfoTip>
          </p>
          {left.length === 0 ? <p className="rounded-xl bg-success-soft/60 px-3 py-2 text-sm font-semibold text-success">Everything is placed.</p> : <ul className="space-y-2">{left.map((r) => <LeftRow key={r.key} row={r} canEdit={canEdit} />)}</ul>}
        </TabsContent>
        <TabsContent value="attention" className="space-y-2">
          {mine.length === 0 ? (
            <p className="rounded-xl bg-success-soft/60 px-3 py-2 text-sm font-semibold text-success">Nothing needs attention here.</p>
          ) : (
            <ul className="space-y-1.5">
              {mine.slice(0, 6).map((r) => (
                <li key={r.rowId} className="rounded-lg border border-line bg-white px-3 py-2 text-[13px]">
                  <p className="font-semibold">{r.title}</p>
                  <p className="text-muted">{r.message}</p>
                </li>
              ))}
            </ul>
          )}
          <Button asChild variant="outline" size="sm">
            <Link to="/timetable/attention">See Everything</Link>
          </Button>
        </TabsContent>
        <TabsContent value="coverage">
          <ul className="space-y-2" aria-label="Coverage">
            {rows.map((r) => (
              <li key={r.key} className="text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{r.subjectName}</span>
                  <span className="text-muted">
                    {Math.min(r.placed, r.needed)} / {r.needed}
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-pill bg-ink/10" role="progressbar" aria-valuenow={Math.min(r.placed, r.needed)} aria-valuemax={r.needed} aria-label={`${r.subjectName} placed`}>
                  <div className={cn('h-full rounded-pill', r.left === 0 ? 'bg-success' : 'bg-brand')} style={{ width: `${r.needed === 0 ? 100 : Math.min(100, (r.placed / r.needed) * 100)}%` }} />
                </div>
              </li>
            ))}
            {rows.length === 0 && <li className="text-sm text-muted">No Subject Needs are set for this view.</li>}
          </ul>
        </TabsContent>
      </Tabs>
    </Card>
  );
}
