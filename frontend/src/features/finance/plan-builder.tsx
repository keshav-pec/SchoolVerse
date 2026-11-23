import { useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, Plus, Trash2 } from 'lucide-react';
import { FEE_FREQUENCIES, PRORATION_METHODS, STUDENT_TYPES, type FeeFrequency, type FeePlanDTO, type FeePlanVersionDTO, type FeeStudentType, type PlanValidationDTO, type ProrationMethod } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { ImpactPreview } from '@/components/finance/impact-preview';
import { Money, MoneyField } from '@/components/finance/money';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { formatMoneyShort } from '@/lib/money';
import { useClassOfferings } from '../academic/api';
import { useStudentContext } from '../students/context';
import { financeApi, useFeeHeads, useFeePlans, useFinanceMutation } from './api';
import { FREQUENCY_LABELS, PRORATION_LABELS, TIP_PRORATION } from './help-copy';

interface Row {
  key: string;
  feeHeadId: string;
  amount: number | null;
  frequency: FeeFrequency;
  dueDay: string;
  graceDays: string;
  proration: ProrationMethod;
  optional: boolean;
}

let rowCounter = 0;
const newRow = (over: Partial<Row> = {}): Row => ({ key: `row-${++rowCounter}`, feeHeadId: '', amount: null, frequency: 'MONTHLY', dueDay: '10', graceDays: '0', proration: 'FULL_PERIOD', optional: false, ...over });

const rowsOf = (v: FeePlanVersionDTO | null): Row[] =>
  v && v.items.length > 0
    ? v.items.map((i) => newRow({ feeHeadId: i.feeHeadId, amount: i.amountPaise, frequency: i.frequency, dueDay: String(i.dueDay), graceDays: String(i.graceDays), proration: i.prorationMethod, optional: i.isOptional }))
    : [newRow()];

/**
 * The fee plan builder: name, classes, fee lines, proration, and an "assign matching students automatically" switch. A draft can be
 * changed freely. A published plan opens read-only with New Version, because published prices never change.
 * `target` is `'new'`, the id of a plan, or `null` (closed).
 */
export function PlanBuilderDrawer({ target, onClose }: { target: string | null; onClose: () => void }) {
  const ctx = useStudentContext();
  const plans = useFeePlans(ctx.sessionId);
  const plan = target && target !== 'new' ? (plans.data?.find((p) => p.planId === target) ?? null) : null;
  return (
    <Drawer open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title={target === 'new' ? 'New fee plan' : (plan?.name ?? 'Fee plan')} description="The price list for a class: what is charged, how often, and when it is due." className="max-w-[760px]">
        {target && <BuilderBody key={`${target}-${plan?.latestVersion?.versionId ?? 'new'}`} plan={plan} onClose={onClose} />}
      </DrawerContent>
    </Drawer>
  );
}

function BuilderBody({ plan: initial, onClose }: { plan: FeePlanDTO | null; onClose: () => void }) {
  const ctx = useStudentContext();
  const offerings = useClassOfferings(ctx.sessionId, ctx.locationId);
  const heads = useFeeHeads();
  const [plan, setPlan] = useState<FeePlanDTO | null>(initial);
  const version = plan?.latestVersion ?? null;
  const editable = !version || version.state === 'DRAFT' || version.state === 'APPROVED';

  const [name, setName] = useState(plan?.name ?? '');
  const [classIds, setClassIds] = useState<string[]>(plan?.appliesTo.classIds ?? []);
  const [studentType, setStudentType] = useState<FeeStudentType>(plan?.appliesTo.studentType ?? 'ALL');
  const [autoAssign, setAutoAssign] = useState(plan?.autoAssign ?? true);
  const [effectiveFrom, setEffectiveFrom] = useState(version?.effectiveFrom ?? '');
  const [rows, setRows] = useState<Row[]>(() => rowsOf(version));
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<(PlanValidationDTO & { impact: { students: number; expectedPaise: number } }) | null>(null);
  const [confirm, setConfirm] = useState(false);

  const create = useFinanceMutation((body: Record<string, unknown>) => financeApi.createPlan(body), { quiet: true });
  const update = useFinanceMutation(
    async (vars: { planId: string; versionId: string; name: string; autoAssign: boolean; body: Record<string, unknown> }) => {
      if (vars.name !== plan?.name || vars.autoAssign !== plan.autoAssign) await financeApi.updatePlan(vars.planId, { name: vars.name, autoAssign: vars.autoAssign });
      return financeApi.updateVersion(vars.versionId, vars.body);
    },
    { quiet: true },
  );
  const newVersion = useFinanceMutation((planId: string) => financeApi.createVersion(planId), { success: 'A new draft version is ready.' });
  const publish = useFinanceMutation((versionId: string) => financeApi.publishVersion(versionId), { success: 'The plan is published.' });
  const validate = useFinanceMutation((versionId: string) => financeApi.validateVersion(versionId), { quiet: true });

  const headOptions = useMemo(() => (heads.data ?? []).filter((h) => h.status === 'ACTIVE').map((h) => ({ value: h.feeHeadId, label: h.name, hint: h.isOptional ? 'optional' : h.code })), [heads.data]);
  const itemsBody = rows.map((r) => ({ feeHeadId: r.feeHeadId, amountPaise: r.amount, frequency: r.frequency, dueDay: Number(r.dueDay), graceDays: Number(r.graceDays), prorationMethod: r.proration, isOptional: r.optional }));
  const rowOk = (r: Row) => r.feeHeadId !== '' && r.amount !== null && r.amount > 0 && Number.isInteger(Number(r.dueDay)) && Number(r.dueDay) >= 1 && Number(r.dueDay) <= 28 && Number.isInteger(Number(r.graceDays)) && Number(r.graceDays) >= 0;
  const ready = name.trim() !== '' && !!ctx.sessionId && !!ctx.locationId && rows.length > 0 && rows.every(rowOk);

  const runCheck = async (versionId: string) => {
    try {
      setCheck(await validate.mutateAsync(versionId));
    } catch (e) {
      setError(messageFor(e));
    }
  };

  const save = async () => {
    setError(null);
    try {
      if (!plan) {
        const made = await create.mutateAsync({
          name: name.trim(),
          sessionId: ctx.sessionId,
          appliesTo: { locationIds: ctx.locationId ? [ctx.locationId] : [], classIds, studentType },
          autoAssign,
          ...(effectiveFrom ? { effectiveFrom } : {}),
          items: itemsBody,
        });
        setPlan(made);
        if (made.latestVersion) await runCheck(made.latestVersion.versionId);
      } else if (version) {
        const next = await update.mutateAsync({ planId: plan.planId, versionId: version.versionId, name: name.trim(), autoAssign, body: { ...(effectiveFrom ? { effectiveFrom } : {}), items: itemsBody } });
        setPlan(next);
        await runCheck(version.versionId);
      }
    } catch (e) {
      setError(messageFor(e));
    }
  };

  const classNames = (ids: string[]) => (ids.length === 0 ? 'Every class' : ids.map((id) => offerings.data?.find((o) => o.classId === id)?.displayName ?? 'A class').join(', '));
  const busy = create.isPending || update.isPending;

  // ───────────────────────────── a published plan: read-only
  if (!editable && plan && version) {
    return (
      <>
        <DrawerBody className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <FinanceStatusPill status={version.state} />
            <span className="text-sm text-muted">
              Version {version.versionNo} · starts {formatDateOnly(version.effectiveFrom)}
            </span>
          </div>
          <Alert tone="info" title="A published plan never changes">
            To change a price, make a new version. Bills that were already made keep the old price.
          </Alert>
          <p className="text-sm">
            <b>Applies to:</b> {classNames(plan.appliesTo.classIds)} · {plan.appliesTo.studentType === 'ALL' ? 'all students' : plan.appliesTo.studentType === 'NEW' ? 'new students' : 'existing students'}
            {plan.autoAssign ? ' · assigned automatically' : ''}
          </p>
          <ItemsTable version={version} />
          <p className="text-sm text-muted">
            A student pays <Money paise={version.yearlyPaise} strong /> in a full year, not counting optional fees.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            loading={newVersion.isPending}
            loadingText="Making…"
            onClick={() => newVersion.mutate(plan.planId, { onError: (e) => setError(messageFor(e)) })}
          >
            <Plus /> New Version
          </Button>
        </DrawerFooter>
      </>
    );
  }

  // ───────────────────────────── a draft: the builder
  return (
    <>
      <DrawerBody className="space-y-5">
        {version && (
          <div className="flex flex-wrap items-center gap-2">
            <FinanceStatusPill status={version.state} />
            <span className="text-sm text-muted">Version {version.versionNo}</span>
          </div>
        )}
        <TextField label="Plan name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Class VIII 2026-27." maxLength={120} />

        {!plan ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Which classes?</legend>
            <p className="text-[13px] text-muted">
              At {ctx.location?.displayName ?? 'this campus'}, in {ctx.session?.code ?? 'this year'}. Leave all unticked to use the plan for every class.
            </p>
            <div className="flex flex-wrap gap-2">
              {(offerings.data ?? []).map((o) => {
                const on = classIds.includes(o.classId);
                return (
                  <label key={o.classOfferingId} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-pill border px-3 text-sm ${on ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line bg-white'}`}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={(e) => setClassIds(e.target.checked ? [...classIds, o.classId] : classIds.filter((c) => c !== o.classId))} />
                    {o.displayName}
                  </label>
                );
              })}
            </div>
            <ComboboxField
              label="Which students?"
              value={studentType}
              onChange={(v) => setStudentType(v as FeeStudentType)}
              options={STUDENT_TYPES.map((t) => ({ value: t, label: t === 'ALL' ? 'All students' : t === 'NEW' ? 'New students only' : 'Existing students only' }))}
              searchPlaceholder="Search…"
            />
          </fieldset>
        ) : (
          <p className="text-sm">
            <b>Applies to:</b> {classNames(plan.appliesTo.classIds)}. <span className="text-muted">Classes cannot be changed after the plan is made.</span>
          </p>
        )}

        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-5 accent-[var(--color-brand)]" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
          <span>
            <b>Assign matching students automatically</b>
            <span className="block text-[13px] text-muted">A new student who joins a matching class gets this plan by themselves.</span>
          </span>
        </label>
        <TextField label="Starts on" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} hint="Optional. Leave empty to start with the school year." />

        <section aria-label="Fee lines" className="space-y-3">
          <h3 className="flex items-center gap-1.5 text-base font-bold">
            Fee lines
            <InfoTip label="About proration">{TIP_PRORATION}</InfoTip>
          </h3>
          {rows.map((r, i) => (
            <fieldset key={r.key} className="space-y-3 rounded-xl border border-line p-3" aria-label={`Fee line ${i + 1}`}>
              <div className="grid gap-3 sm:grid-cols-2">
                <ComboboxField
                  label="Fee type"
                  required
                  value={r.feeHeadId}
                  onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, feeHeadId: v } : x)))}
                  placeholder="Choose…"
                  searchPlaceholder="Search fee types…"
                  options={headOptions}
                />
                <MoneyField label="Amount" required value={r.amount} onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: v } : x)))} />
                <ComboboxField
                  label="How often"
                  value={r.frequency}
                  onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, frequency: v as FeeFrequency } : x)))}
                  options={FEE_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] ?? f }))}
                  searchPlaceholder="Search…"
                />
                <ComboboxField
                  label="If a student joins part-way"
                  value={r.proration}
                  onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, proration: v as ProrationMethod } : x)))}
                  options={PRORATION_METHODS.map((m) => ({ value: m, label: PRORATION_LABELS[m] ?? m }))}
                  searchPlaceholder="Search…"
                />
                <TextField label="Due on day" type="number" min={1} max={28} value={r.dueDay} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, dueDay: e.target.value } : x)))} hint="Day of the month, 1 to 28." />
                <TextField label="Grace days" type="number" min={0} max={90} value={r.graceDays} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, graceDays: e.target.value } : x)))} hint="Days after the due date before it counts as late." />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={r.optional} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, optional: e.target.checked } : x)))} />
                  Optional (a student pays it only if chosen)
                </label>
                <Button variant="ghost" size="sm" disabled={rows.length === 1} onClick={() => setRows(rows.filter((x) => x.key !== r.key))} aria-label={`Remove fee line ${i + 1}`}>
                  <Trash2 /> Remove
                </Button>
              </div>
            </fieldset>
          ))}
          <Button variant="outline" size="sm" onClick={() => setRows([...rows, newRow()])}>
            <Plus /> Add Fee Line
          </Button>
        </section>

        {check && (
          <section aria-label="Plan checks" className="space-y-1.5">
            <h3 className="text-base font-bold">Checks</h3>
            {check.ok ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <CircleCheck className="size-4" aria-hidden="true" /> No problems found. This plan is ready to publish.
              </p>
            ) : (
              <ul className="space-y-1">
                {check.problems.map((p, i) => (
                  <li key={`${p.code}-${i}`} className="flex items-start gap-2 text-sm text-danger">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {p.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button variant="secondary" disabled={!ready} loading={busy} loadingText="Saving…" onClick={() => void save()}>
          Save Draft
        </Button>
        <Button disabled={!check?.ok || busy} onClick={() => setConfirm(true)}>
          Publish…
        </Button>
      </DrawerFooter>
      {version && check?.ok && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Publish this plan?"
          description="Once it is published, its prices are frozen. You can still make a new version later."
          confirmLabel="Publish Plan"
          loadingLabel="Publishing…"
          onConfirm={async () => {
            await publish.mutateAsync(version.versionId);
            onClose();
          }}
        >
          <ImpactPreview
            lines={[
              { label: 'Students this plan will apply to', value: check.impact.students },
              { label: 'Expected this year', value: formatMoneyShort(check.impact.expectedPaise) },
            ]}
            note="After publishing, assign the students from the panel at the top of this page."
          />
        </ConfirmDialog>
      )}
    </>
  );
}

function ItemsTable({ version }: { version: FeePlanVersionDTO }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="bg-canvas text-left text-[13px] text-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">Fee</th>
            <th className="px-3 py-2 font-semibold">How often</th>
            <th className="px-3 py-2 font-semibold">Due</th>
            <th className="px-3 py-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {version.items.map((i) => (
            <tr key={i.itemId}>
              <td className="px-3 py-2">
                {i.feeHeadName} {i.isOptional && <span className="text-[13px] text-muted">(optional)</span>}
              </td>
              <td className="px-3 py-2">{FREQUENCY_LABELS[i.frequency]}</td>
              <td className="px-3 py-2">Day {i.dueDay}</td>
              <td className="px-3 py-2 text-right">
                <Money paise={i.amountPaise} strong />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
