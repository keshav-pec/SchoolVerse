import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Copy, RotateCcw } from 'lucide-react';
import {
  DOUBLE_MODES,
  PREFERRED_BANDS,
  SPACE_SUITABILITY_TAGS,
  type DoubleMode,
  type EffectiveRequirementDTO,
  type PreferredBand,
  type RequirementCopyResultDTO,
  type RequirementListDTO,
  type RequirementSaveResultDTO,
  type RequirementValuesDTO,
  type SuitabilityTagCode,
  type TimetablePlanDTO,
} from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { EmptyState } from '@/components/sv/empty-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { InfoTip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useClassOfferings, useSections } from '../../academic/api';
import { useStudentContext } from '../../students/context';
import { useRequirements, useTimetableMutation } from '../api';
import { NEEDS_INTRO, TIPS } from '../help-copy';

const ROOM_KINDS = [{ value: '', label: 'No special room' }, ...SPACE_SUITABILITY_TAGS.filter((t) => t.code !== 'GENERAL_TEACHING').map((t) => ({ value: t.code, label: t.label }))];
const DOUBLE_LABELS: Record<DoubleMode, string> = { NONE: 'No doubles', PREFERRED: 'Prefer doubles', REQUIRED: 'Must have doubles' };
const BAND_LABELS: Record<PreferredBand, string> = { ANY: 'Any time', MORNING: 'Morning', AFTERNOON: 'Afternoon', AVOID_LAST: 'Not the last period' };

type Draft = Partial<Omit<RequirementValuesDTO, 'periodsPerWeek'>> & { periodsPerWeek?: number | '' };

function liveTotal(needed: number, available: number | null) {
  if (available === null) return { ok: true, text: `Total ${needed} period${needed === 1 ? '' : 's'}. Set up Daily Periods to see if they fit the week.` };
  return needed <= available ? { ok: true, text: `Total ${needed} of ${available} periods` } : { ok: false, text: `Needs ${needed} periods, the week has ${available}` };
}

// ───────────────────────────────────────────────────────────── one row

function Row({ row, draft, editable, sectionMode, onDraft, onChange, onReset }: { row: EffectiveRequirementDTO; draft: Draft | undefined; editable: boolean; sectionMode: boolean; onDraft: () => void; onChange: (patch: Draft) => void; onReset: () => void }) {
  const [more, setMore] = useState(false);
  const v = { ...row.effective, ...draft };
  const using = sectionMode && row.source !== 'SECTION' && !draft;
  const kind = (v.neededSuitability?.[0] ?? '') as string;
  return (
    <li className="space-y-2 rounded-xl border border-line bg-white p-3">
      <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1.3fr)_6.5rem_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <p className="truncate font-semibold">{row.subjectName}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
            {using && (
              <>
                Using class default <InfoTip label="About using the class default">{TIPS.classDefault}</InfoTip>
              </>
            )}
            {sectionMode && (row.source === 'SECTION' || draft) && <Badge tone="sun">Different</Badge>}
            {!sectionMode && !row.configured && !draft && <Badge tone="warning">Not set yet</Badge>}
          </p>
        </div>
        <label className="space-y-1 text-sm font-semibold">
          <span>Periods a week</span>
          <Input type="number" min={0} max={60} inputMode="numeric" disabled={!editable} value={v.periodsPerWeek ?? ''} placeholder={row.configured ? undefined : '0'} aria-label={`Periods a week for ${row.subjectName}`} onChange={(e) => onChange({ periodsPerWeek: e.target.value === '' ? '' : Number(e.target.value) })} />
        </label>
        <div className="space-y-1">
          <span className="flex items-center gap-1 text-sm font-semibold">
            Needs a special room <InfoTip label="About a special room">{TIPS.specialRoom}</InfoTip>
          </span>
          <Combobox aria-label={`Special room for ${row.subjectName}`} disabled={!editable} value={kind} onChange={(x) => onChange({ neededSuitability: x ? [x as SuitabilityTagCode] : [] })} options={ROOM_KINDS} searchPlaceholder="Search room kinds…" />
        </div>
        <div className="space-y-1">
          <span className="flex items-center gap-1 text-sm font-semibold">
            Double periods <InfoTip label="About double periods">{TIPS.doublePeriods}</InfoTip>
          </span>
          <Combobox aria-label={`Double periods for ${row.subjectName}`} disabled={!editable} value={v.doubleMode ?? 'NONE'} onChange={(x) => onChange({ doubleMode: x as DoubleMode, doublesPerWeek: x === 'NONE' ? 0 : Math.max(1, v.doublesPerWeek ?? 0) })} options={DOUBLE_MODES.map((m) => ({ value: m, label: DOUBLE_LABELS[m] }))} searchPlaceholder="Search…" />
        </div>
        <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
          {sectionMode && !editable && (
            <Button variant="outline" size="sm" onClick={onDraft}>
              Change For This Section
            </Button>
          )}
          {sectionMode && row.source === 'SECTION' && !draft && (
            <Button variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw /> Reset
            </Button>
          )}
          {editable && (
            <Button variant="ghost" size="sm" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? 'Less' : 'More'}
            </Button>
          )}
        </div>
      </div>
      {more && editable && (
        <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
          {v.doubleMode !== 'NONE' && (
            <label className="space-y-1 text-sm font-semibold">
              <span>How many doubles a week</span>
              <Input type="number" min={1} max={30} value={v.doublesPerWeek ?? 1} aria-label={`Doubles a week for ${row.subjectName}`} onChange={(e) => onChange({ doublesPerWeek: Number(e.target.value) })} />
            </label>
          )}
          <label className="space-y-1 text-sm font-semibold">
            <span>Most in one day</span>
            <Input type="number" min={1} max={12} value={v.maxPerDay ?? 2} aria-label={`Most in one day for ${row.subjectName}`} onChange={(e) => onChange({ maxPerDay: Number(e.target.value) })} />
          </label>
          <div className="space-y-1">
            <span className="text-sm font-semibold">Best time of day</span>
            <Combobox aria-label={`Best time for ${row.subjectName}`} value={v.preferredBand ?? 'ANY'} onChange={(x) => onChange({ preferredBand: x as PreferredBand })} options={PREFERRED_BANDS.map((b) => ({ value: b, label: BAND_LABELS[b] }))} searchPlaceholder="Search…" />
          </div>
        </div>
      )}
    </li>
  );
}

// ───────────────────────────────────────────────────────────── copy to other sections

function CopyModal({ plan, classOfferingId, fromSectionId, onClose }: { plan: TimetablePlanDTO; classOfferingId: string; fromSectionId: string; onClose: () => void }) {
  const sections = useSections(classOfferingId);
  const [picked, setPicked] = useState<string[]>([]);
  const others = (sections.data ?? []).filter((s) => s.sectionOfferingId !== fromSectionId);
  const copy = useTimetableMutation((ids: string[]) => api.post<RequirementCopyResultDTO>('/subject-schedule-requirements/copy-section', { planId: plan.planId, fromSectionId, toSectionIds: ids }), { success: (r) => r.message });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Copy To Other Sections"
      description="The other sections get the same values as this section. Only the differences from the class are stored."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={picked.length === 0} loading={copy.isPending} loadingText="Copying…" onClick={async () => void (await copy.mutateAsync(picked).then(onClose, () => undefined))}>
            Copy To {picked.length} {picked.length === 1 ? 'Section' : 'Sections'}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPicked(others.map((s) => s.sectionOfferingId))}>
            Select All
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPicked([])}>
            Clear
          </Button>
        </div>
        {others.length === 0 && <p className="text-sm text-muted">This class has no other sections.</p>}
        <ul className="grid gap-1 sm:grid-cols-2">
          {others.map((s) => (
            <li key={s.sectionOfferingId}>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-brand" checked={picked.includes(s.sectionOfferingId)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.sectionOfferingId] : picked.filter((x) => x !== s.sectionOfferingId))} />
                Section {s.sectionCode}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── the table

function NeedsTable({ plan, data, sectionMode, canEdit }: { plan: TimetablePlanDTO; data: RequirementListDTO; sectionMode: boolean; canEdit: boolean }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saved, setSaved] = useState(false);
  const [copying, setCopying] = useState(false);
  const patch = (id: string, change: Draft) => {
    setSaved(false);
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...change } }));
  };
  const save = useTimetableMutation(
    (items: { subjectOfferingId: string; draft: Draft }[]) => {
      const body = (i: { subjectOfferingId: string; draft: Draft }) => ({ subjectOfferingId: i.subjectOfferingId, ...i.draft });
      return sectionMode
        ? api.put<RequirementSaveResultDTO>('/subject-schedule-requirements', { planId: plan.planId, items: items.map((i) => ({ scope: 'SECTION', classOfferingId: data.classOfferingId, sectionOfferingId: data.sectionOfferingId, ...body(i) })) })
        : api.post<RequirementSaveResultDTO>('/subject-schedule-requirements/apply-grade', { planId: plan.planId, classOfferingId: data.classOfferingId, items: items.map(body) });
    },
    { success: 'Subject Needs saved.' },
  );
  const reset = useTimetableMutation((subjectOfferingId: string) => api.post('/subject-schedule-requirements/reset-section', { planId: plan.planId, sectionOfferingId: data.sectionOfferingId, subjectOfferingIds: [subjectOfferingId] }), { success: 'This section uses the class value again.' });

  const dirty = Object.entries(drafts).filter(([, d]) => Object.keys(d).length > 0);
  const blank = dirty.some(([id, d]) => d.periodsPerWeek === '' || (d.periodsPerWeek === undefined && !data.items.find((i) => i.subjectOfferingId === id)?.configured));
  const needed = data.items.reduce((n, i) => {
    const p = drafts[i.subjectOfferingId]?.periodsPerWeek ?? i.effective.periodsPerWeek;
    return n + (typeof p === 'number' ? p : 0);
  }, 0);
  const total = dirty.length === 0 ? { ok: data.total.ok, text: data.total.message } : liveTotal(needed, data.total.available);

  const send = async () => {
    const items = dirty.map(([subjectOfferingId, d]) => {
      const row = data.items.find((i) => i.subjectOfferingId === subjectOfferingId)!;
      return { subjectOfferingId, draft: { ...row.effective, ...d, periodsPerWeek: d.periodsPerWeek === '' || d.periodsPerWeek === undefined ? row.effective.periodsPerWeek : d.periodsPerWeek } as Draft };
    });
    // Only what the form shows is sent; the extra limits (least and most a week) stay as they were.
    const clean = items.map((i) => ({ subjectOfferingId: i.subjectOfferingId, draft: { periodsPerWeek: i.draft.periodsPerWeek, maxPerDay: i.draft.maxPerDay, doubleMode: i.draft.doubleMode, doublesPerWeek: i.draft.doublesPerWeek, preferredBand: i.draft.preferredBand, neededSuitability: i.draft.neededSuitability } }));
    await save.mutateAsync(clean).then(() => {
      setDrafts({});
      setSaved(true);
    }, () => undefined);
  };

  if (data.items.length === 0)
    return <EmptyState title="No subjects in this class yet" description="Add the subjects this class studies in Academic Setup. Then come back here." action={<Button asChild variant="outline"><a href="/academics">Go To Academic Setup</a></Button>} />;

  return (
    <div className="space-y-3">
      <ul className="space-y-2" aria-label="Subjects">
        {data.items.map((row) => {
          const draft = drafts[row.subjectOfferingId];
          const editable = canEdit && (!sectionMode || row.source === 'SECTION' || !!draft);
          return (
            <Row
              key={row.subjectOfferingId}
              row={row}
              draft={draft}
              editable={editable}
              sectionMode={sectionMode && canEdit}
              onDraft={() => patch(row.subjectOfferingId, {})}
              onChange={(c) => patch(row.subjectOfferingId, c)}
              onReset={() => reset.mutate(row.subjectOfferingId)}
            />
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-canvas/70 px-4 py-3">
        <p className={cn('text-sm font-bold', total.ok ? 'text-ink' : 'text-danger')} role="status" data-testid="needs-total">
          {total.text}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {saved && <span className="text-sm font-semibold text-success">Saved</span>}
          {sectionMode && canEdit && (
            <Button variant="outline" onClick={() => setCopying(true)}>
              <Copy /> Copy To Other Sections
            </Button>
          )}
          {canEdit && (
            <Button disabled={dirty.length === 0 || blank} loading={save.isPending} loadingText="Saving…" onClick={() => void send()}>
              Save Needs
            </Button>
          )}
        </div>
      </div>
      {blank && dirty.length > 0 && <p className="text-sm text-muted">Type the periods a week for each subject you changed.</p>}
      {copying && data.sectionOfferingId && <CopyModal plan={plan} classOfferingId={data.classOfferingId} fromSectionId={data.sectionOfferingId} onClose={() => setCopying(false)} />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── the tab

export function NeedsTab({ plan, canEdit }: { plan: TimetablePlanDTO; canEdit: boolean }) {
  const ctx = useStudentContext();
  const [params, setParams] = useSearchParams();
  const classes = useClassOfferings(ctx.sessionId, ctx.locationId);
  const list = useMemo(() => classes.data ?? [], [classes.data]);
  const requested = params.get('classOfferingId');
  const classId = list.find((c) => c.classOfferingId === requested)?.classOfferingId ?? list[0]?.classOfferingId;
  const [sectionId, setSectionId] = useState('');
  const sections = useSections(classId);
  const section = (sections.data ?? []).find((s) => s.sectionOfferingId === sectionId);
  const needs = useRequirements(plan.planId, classId, section?.sectionOfferingId);
  const setClass = (id: string) => {
    setSectionId('');
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('classOfferingId', id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <TabIntro title="Subject Needs" need="required">
        {NEEDS_INTRO}
      </TabIntro>
      {classes.isLoading && <Skeleton className="h-32 rounded-card" role="status" aria-label="Loading classes" />}
      {classes.data && list.length === 0 && <EmptyState title="No classes at this campus yet" description="Add the classes for this school year in Academic Setup first." action={<Button asChild><a href="/academics">Go To Academic Setup</a></Button>} />}
      {classId && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-end gap-3">
            <ComboboxField label="Class" value={classId} onChange={setClass} options={list.map((c) => ({ value: c.classOfferingId, label: c.displayName, hint: `${c.sectionCount} sections` }))} searchPlaceholder="Search classes…" containerClassName="min-w-52" />
            <ComboboxField
              label="Section"
              value={sectionId}
              onChange={setSectionId}
              options={[{ value: '', label: 'Whole class', hint: 'Same for every section' }, ...(sections.data ?? []).map((s) => ({ value: s.sectionOfferingId, label: `Section ${s.sectionCode}` }))]}
              searchPlaceholder="Search sections…"
              containerClassName="min-w-52"
              labelAside={<InfoTip label="About sections">{TIPS.classDefault}</InfoTip>}
            />
          </div>
          <HelpHeading title={section ? `Subject Needs for Section ${section.sectionCode}` : 'Subject Needs for the whole class'} className="text-lg font-bold" help={<p>Every section of the class uses these values until someone changes them for one section.</p>} />
          {needs.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading Subject Needs" />}
          {needs.isError && <ErrorState error={needs.error} onRetry={() => void needs.refetch()} />}
          {needs.data && (
            <>
              {!section && needs.data.sectionsWithOverrides > 0 && <Alert tone="info">{needs.data.sectionsWithOverrides} {needs.data.sectionsWithOverrides === 1 ? 'section has' : 'sections have'} its own values. Choose that section above to see or reset them.</Alert>}
              <NeedsTable key={`${classId}:${section?.sectionOfferingId ?? ''}`} plan={plan} data={needs.data} sectionMode={!!section} canEdit={canEdit} />
            </>
          )}
        </Card>
      )}
    </div>
  );
}
