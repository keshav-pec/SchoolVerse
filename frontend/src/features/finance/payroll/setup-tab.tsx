import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, ShieldAlert } from 'lucide-react';
import type { SalaryComponentDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { bpsToPercentText, formatMoney, percentTextToBps } from '@/lib/money';
import { FIN, useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { ErrorBanner } from '../error-banner';
import { COMPONENT_CALC_LABELS, COMPONENT_TYPE_LABELS, SALARY_SETUP_INTRO, TIP_STATUTORY } from '../help-copy';
import { payApi, useCompensations, useComponents, useRevisions, useRules, useStructures } from '../ops-api';
import { todayLocal } from '../collect/shared';

const paramText = (params: Record<string, unknown>) =>
  Object.entries(params)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');

function RulesCard() {
  const rules = useRules();
  const approve = useFinanceMutation((id: string) => payApi.approveRule(id), { success: 'Rule approved.' });
  const demo = (rules.data ?? []).filter((r) => r.demo && r.state === 'DRAFT');
  return (
    <Card aria-label="Statutory rules">
      <CardHeader>
        <HelpHeading title="Statutory rules (PF, ESI, Professional Tax)" help={TIP_STATUTORY} helpLabel="About statutory rules" />
      </CardHeader>
      {demo.length > 0 && (
        <Alert tone="danger" title="Demo values" className="mb-3">
          <span className="flex items-start gap-1.5">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            These rules came with SchoolVerse as examples. Your accountant must check the numbers and approve them before real salaries are paid.
          </span>
        </Alert>
      )}
      {rules.isLoading ? (
        <Skeleton className="h-16" />
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Rules">
          {(rules.data ?? []).map((r) => (
            <li key={r.ruleId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <b className="w-10">{r.kind}</b>
              <span className="min-w-0 flex-1 text-muted">
                From {formatDateOnly(r.effectiveFrom)} · {paramText(r.params)}
                {r.approvedByName ? ` · approved by ${r.approvedByName}` : ''}
              </span>
              <FinanceStatusPill status={r.state} label={r.demo && r.state === 'DRAFT' ? 'Demo' : undefined} />
              {r.state === 'DRAFT' && (
                <Can permission="payroll:run:approve">
                  <Button size="sm" variant="outline" loading={approve.isPending && approve.variables === r.ruleId} loadingText="Saving…" onClick={() => approve.mutate(r.ruleId)} aria-label={`Approve ${r.kind} rule`}>
                    Approve
                  </Button>
                </Can>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StructureDialog({ components, onClose }: { components: SalaryComponentDTO[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(todayLocal().slice(0, 8) + '01');
  const [items, setItems] = useState<Record<string, { amount: number | null; rate: string }>>(() => Object.fromEntries(components.filter((c) => c.code === 'BASIC').map((c) => [c.componentId, { amount: null, rate: '' }])));
  const save = useFinanceMutation((body: Record<string, unknown>) => payApi.createStructure(body), { success: 'Structure saved. A person with approval rights approves it next.' });
  const active = components.filter((c) => c.status === 'ACTIVE');
  const body = {
    name: name.trim(),
    effectiveFrom: from,
    items: Object.entries(items).map(([componentId, v]) => {
      const c = components.find((x) => x.componentId === componentId)!;
      return c.calc === 'FIXED' ? { componentId, ...(v.amount ? { amountPaise: v.amount } : {}) } : { componentId, rateBps: percentTextToBps(v.rate) ?? 0 };
    }),
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New salary structure"
      description="A structure is a pattern, such as “Basic + 40% HRA”. Each person’s Basic is set when you assign it."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || body.items.length === 0} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate(body, { onSuccess: onClose })}>
            Save Structure
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Senior Teacher" maxLength={80} />
          <TextField label="Starts from" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">Salary parts</legend>
          {active.map((c) => {
            const on = items[c.componentId] !== undefined;
            const v = items[c.componentId];
            return (
              <div key={c.componentId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2 text-sm">
                <label className="flex min-w-48 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--color-brand)]"
                    checked={on}
                    onChange={(e) => setItems((p) => (e.target.checked ? { ...p, [c.componentId]: { amount: null, rate: '' } } : Object.fromEntries(Object.entries(p).filter(([k]) => k !== c.componentId))))}
                  />
                  <span>
                    <b>{c.name}</b> <span className="text-muted">· {COMPONENT_TYPE_LABELS[c.type]} · {COMPONENT_CALC_LABELS[c.calc]}</span>
                  </span>
                </label>
                {on && c.calc === 'FIXED' && c.code !== 'BASIC' && <MoneyField label={`${c.name} amount`} value={v!.amount} onChange={(amount) => setItems((p) => ({ ...p, [c.componentId]: { ...v!, amount } }))} containerClassName="w-40" />}
                {on && c.calc !== 'FIXED' && (
                  <TextField label={`${c.name} %`} value={v!.rate} onChange={(e) => setItems((p) => ({ ...p, [c.componentId]: { ...v!, rate: e.target.value } }))} containerClassName="w-28" inputMode="decimal" />
                )}
                {on && c.code === 'BASIC' && <span className="text-[13px] text-muted">Set per person</span>}
              </div>
            );
          })}
        </fieldset>
        {save.error && <ErrorBanner error={save.error} />}
      </div>
    </Modal>
  );
}

function StructuresCard() {
  const structures = useStructures();
  const components = useComponents();
  const [adding, setAdding] = useState(false);
  const approve = useFinanceMutation((id: string) => payApi.approveStructureVersion(id), { success: 'Structure approved.' });
  return (
    <Card aria-label="Salary structures">
      <CardHeader>
        <HelpHeading title="Salary structures" help={<p>A structure lists the salary parts and how each is worked out. A change makes a new version; old payslips keep the old one.</p>} />
        <Can permission="payroll:structure:manage">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={!components.data}>
            <Plus /> New Structure
          </Button>
        </Can>
      </CardHeader>
      {structures.isLoading ? (
        <Skeleton className="h-16" />
      ) : (structures.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted">No structure yet. Add one, such as “Basic + 40% HRA”.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Structures">
          {structures.data!.map((s) => (
            <li key={s.structureId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <b>{s.name}</b>
              <span className="min-w-0 flex-1 text-muted">
                v{s.latestVersion?.versionNo} · {s.latestVersion?.items.map((i) => (i.rateBps !== null ? `${i.componentName} ${bpsToPercentText(i.rateBps)}%` : i.amountPaise ? `${i.componentName} ${formatMoney(i.amountPaise)}` : i.componentName)).join(' + ')}
              </span>
              {s.latestVersion && <FinanceStatusPill status={s.latestVersion.state} />}
              {s.latestVersion?.state === 'DRAFT' && (
                <Can permission="payroll:run:approve">
                  <Button size="sm" variant="outline" loading={approve.isPending} loadingText="Saving…" onClick={() => approve.mutate(s.latestVersion!.versionId)} aria-label={`Approve ${s.name}`}>
                    Approve
                  </Button>
                </Can>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && components.data && <StructureDialog components={components.data} onClose={() => setAdding(false)} />}
    </Card>
  );
}

/** Assign Suggested Salaries: everyone without a salary, with the structure that fits their designation. Type each Basic and assign. */
function SuggestDialog({ onClose }: { onClose: () => void }) {
  const structures = useStructures();
  const suggest = useQuery({ queryKey: [...FIN, 'payroll', 'recommend'], queryFn: () => payApi.recommend({}) });
  const [basics, setBasics] = useState<Record<string, number | null>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [from, setFrom] = useState(todayLocal().slice(0, 8) + '01');
  const [done, setDone] = useState(0);
  const assign = useFinanceMutation((body: Record<string, unknown>) => payApi.assign(body), { quiet: true });
  const approved = (structures.data ?? []).filter((s) => s.latestVersion?.state === 'APPROVED');
  const rows = suggest.data?.items ?? [];
  const ready = rows.filter((r) => (chosen[r.employeeId] ?? r.suggestedStructureVersionId) && basics[r.employeeId]);
  const assignAll = async () => {
    let n = 0;
    for (const r of ready) {
      await assign.mutateAsync({ employeeId: r.employeeId, structureVersionId: chosen[r.employeeId] ?? r.suggestedStructureVersionId, basicPaise: basics[r.employeeId], effectiveFrom: from, mode: 'MONTHLY' });
      n += 1;
      setDone(n);
    }
    onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Assign suggested salaries"
      description="Everyone without a salary. The structure is suggested from their designation. Type each person’s monthly Basic."
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={ready.length === 0} loading={assign.isPending} loadingText={`Assigning ${done + 1} of ${ready.length}…`} onClick={() => void assignAll()}>
            Assign {ready.length} {ready.length === 1 ? 'Salary' : 'Salaries'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Salary starts from" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} containerClassName="w-56" />
        {suggest.isLoading && <Skeleton className="h-24" />}
        {suggest.error && <ErrorBanner error={suggest.error} />}
        {assign.error && <ErrorBanner error={assign.error} />}
        {suggest.data && rows.length === 0 && <p className="text-sm text-success">Everyone has a salary.</p>}
        {approved.length === 0 && rows.length > 0 && <Alert tone="warning">No approved structure yet. Add a structure and approve it first.</Alert>}
        <ul className="divide-y divide-line" aria-label="People without a salary">
          {rows.map((r) => (
            <li key={r.employeeId} className="flex flex-wrap items-end gap-3 py-2 text-sm">
              <span className="min-w-40 flex-1">
                <b>{r.employeeName}</b>
                <span className="block text-muted">{[r.employeeCode, r.designationName].filter(Boolean).join(' · ')}</span>
              </span>
              <ComboboxField
                label="Structure"
                value={chosen[r.employeeId] ?? r.suggestedStructureVersionId ?? ''}
                onChange={(v) => setChosen((p) => ({ ...p, [r.employeeId]: v }))}
                placeholder="Choose…"
                searchPlaceholder="Search structures…"
                options={approved.map((s) => ({ value: s.latestVersion!.versionId, label: s.name, hint: s.latestVersion!.versionId === r.suggestedStructureVersionId ? 'suggested' : undefined }))}
                containerClassName="w-56"
              />
              <MoneyField label="Monthly Basic" value={basics[r.employeeId] ?? null} onChange={(v) => setBasics((p) => ({ ...p, [r.employeeId]: v }))} containerClassName="w-40" />
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function RevisionDialog({ onClose }: { onClose: () => void }) {
  const comp = useCompensations();
  const [employeeId, setEmployeeId] = useState('');
  const [basic, setBasic] = useState<number | null>(null);
  const [date, setDate] = useState(todayLocal());
  const [arrears, setArrears] = useState('PAY_DIFFERENCE');
  const [reason, setReason] = useState('');
  const flow = useApprovalFlow();
  const save = useFinanceMutation((approvalId: string | undefined) => payApi.createRevision({ employeeId, newBasicPaise: basic, effectiveDate: date, arrearPolicy: arrears, reason: reason.trim(), ...(approvalId ? { approvalId } : {}) }), { quiet: true, success: 'Pay change saved.' });
  const current = comp.data?.find((c) => c.employeeId === employeeId && !c.effectiveTo);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Change someone’s pay"
      description="A pay change needs a second person to say yes."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!employeeId || !basic || !reason.trim()} loading={save.isPending} loadingText="Saving…" onClick={() => void flow.run((id) => save.mutateAsync(id)).then((r) => r && onClose())}>
            {flow.label('Save Pay Change')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ComboboxField label="Who?" required value={employeeId} onChange={setEmployeeId} placeholder="Choose…" searchPlaceholder="Search people…" options={[...new Map((comp.data ?? []).map((c) => [c.employeeId, { value: c.employeeId, label: c.employeeName, hint: c.employeeCode }])).values()]} />
        {current && <p className="text-sm text-muted">Basic now: {formatMoney(current.basicPaise)} a month ({current.structureName}).</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyField label="New monthly Basic" required value={basic} onChange={setBasic} />
          <TextField label="Starts from" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <ComboboxField
          label="If the date is in the past"
          value={arrears}
          onChange={setArrears}
          searchPlaceholder="Search…"
          options={[
            { value: 'PAY_DIFFERENCE', label: 'Pay the difference (arrears)', hint: 'next run' },
            { value: 'NONE', label: 'No arrears' },
          ]}
        />
        {arrears === 'PAY_DIFFERENCE' && date < todayLocal().slice(0, 8) + '01' && <Alert tone="info">Arrears will be paid in the next run. Finalised payslips are not changed.</Alert>}
        <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Yearly increment." maxLength={300} />
        {flow.banner}
        {flow.errorBox}
      </div>
    </Modal>
  );
}

function PeopleCard() {
  const { can } = useAuth();
  const comp = useCompensations(can('payroll:salary:view_sensitive'));
  const revisions = useRevisions(can('payroll:salary:view_sensitive'));
  const [suggesting, setSuggesting] = useState(false);
  const [revising, setRevising] = useState(false);
  if (!can('payroll:salary:view_sensitive')) return null;
  const current = (comp.data ?? []).filter((c) => !c.effectiveTo);
  return (
    <Card aria-label="Who gets which salary">
      <CardHeader>
        <HelpHeading title="Who gets which salary" help={<p>Each person’s structure and monthly Basic. Everything else (HRA, PF…) is worked out from it.</p>} />
        <Can permission="payroll:structure:manage">
          <span className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setSuggesting(true)}>
              Assign Suggested Salaries
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRevising(true)}>
              Change Pay
            </Button>
          </span>
        </Can>
      </CardHeader>
      {comp.isLoading ? (
        <Skeleton className="h-16" />
      ) : current.length === 0 ? (
        <p className="text-sm text-muted">Nobody has a salary yet. Press Assign Suggested Salaries.</p>
      ) : (
        <ul className="divide-y divide-line text-sm" aria-label="Salaries">
          {current.map((c) => (
            <li key={c.assignmentId} className="flex flex-wrap items-center gap-x-3 py-2">
              <b>{c.employeeName}</b>
              <span className="min-w-0 flex-1 text-muted">
                {c.employeeCode} · {c.structureName} · from {formatDateOnly(c.effectiveFrom)}
              </span>
              <span>
                Basic <Money paise={c.basicPaise} /> · Gross <Money paise={c.monthlyGrossPaise} strong />
              </span>
            </li>
          ))}
        </ul>
      )}
      {(revisions.data ?? []).filter((r) => r.status === 'PENDING').length > 0 && (
        <Alert tone="warning" title="Pay changes waiting for approval" className="mt-3">
          {revisions.data!.filter((r) => r.status === 'PENDING').map((r) => `${r.employeeName}: ${formatMoney(r.fromBasicPaise)} → ${formatMoney(r.toBasicPaise)} from ${formatDateOnly(r.effectiveDate)}`).join('; ')}. Arrears will be paid in the next run.
        </Alert>
      )}
      {suggesting && <SuggestDialog onClose={() => setSuggesting(false)} />}
      {revising && <RevisionDialog onClose={() => setRevising(false)} />}
    </Card>
  );
}

function ComponentsCard() {
  const components = useComponents();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', type: 'EARNING', calc: 'FIXED' });
  const save = useFinanceMutation((body: Record<string, unknown>) => payApi.createComponent(body), { success: 'Salary part added.' });
  return (
    <Card aria-label="Salary parts">
      <CardHeader>
        <HelpHeading title="Salary parts" help={<p>The pieces a salary is made of, such as Basic, HRA or Transport Allowance. The system parts are locked.</p>} />
        <Can permission="payroll:structure:manage">
          <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            <Plus /> Add Part
          </Button>
        </Can>
      </CardHeader>
      {adding && (
        <div className="mb-3 grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-4">
          <TextField label="Code" required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} hint="Example: TA" maxLength={20} />
          <TextField label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} hint="Example: Transport Allowance" maxLength={60} />
          <ComboboxField label="Kind" value={form.type} onChange={(v) => setForm({ ...form, type: v })} searchPlaceholder="Search…" options={Object.entries(COMPONENT_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          <ComboboxField label="Worked out as" value={form.calc} onChange={(v) => setForm({ ...form, calc: v })} searchPlaceholder="Search…" options={Object.entries(COMPONENT_CALC_LABELS).map(([value, label]) => ({ value, label }))} />
          <div className="sm:col-span-4">
            <Button size="sm" disabled={!form.code || !form.name.trim()} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate(form, { onSuccess: () => setAdding(false) })}>
              Save Part
            </Button>
            {save.error && <ErrorBanner error={save.error} className="mt-2" />}
          </div>
        </div>
      )}
      <ul className="flex flex-wrap gap-2" aria-label="Parts">
        {(components.data ?? []).map((c) => (
          <li key={c.componentId} className="rounded-lg bg-canvas px-3 py-1.5 text-sm">
            <b>{c.name}</b> <span className="text-muted">· {COMPONENT_TYPE_LABELS[c.type]} · {COMPONENT_CALC_LABELS[c.calc]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SetupTab() {
  return (
    <div className="space-y-4">
      <TabIntro title="Salary Setup" need="required">
        {SALARY_SETUP_INTRO}
      </TabIntro>
      <RulesCard />
      <StructuresCard />
      <PeopleCard />
      <ComponentsCard />
    </div>
  );
}
