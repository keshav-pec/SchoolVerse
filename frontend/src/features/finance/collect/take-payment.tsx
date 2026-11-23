import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { Banknote, Building2, FileCheck2, Search, Smartphone, UsersRound, X } from 'lucide-react';
import type { CollectionResultDTO, FeeDocumentListDTO, StudentAccountRowDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { TabIntro } from '@/components/sv/help';
import { Money, MoneyField } from '@/components/finance/money';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useStudentContext } from '../../students/context';
import { FIN, qs, useAccounts, useBankAccounts, useCashAccounts, useFamily, useFinanceMutation, useStudentAccount } from '../api';
import { ErrorBanner } from '../error-banner';
import { TAKE_PAYMENT_INTRO, TIP_ADVANCE, TIP_ALLOCATE } from '../help-copy';
import { collectApi, useMyShift } from '../ops-api';
import { ChoiceCards, PaymentResultCard, todayLocal } from './shared';

type Method = 'CASH' | 'UPI' | 'NEFT' | 'CHEQUE';
interface Child {
  studentId: string;
  studentName: string;
  className: string | null;
}
interface OpenBill {
  documentId: string;
  number: string;
  studentId: string;
  studentName: string;
  dueDate: string;
  balancePaise: number;
  overdue: boolean;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** Walks the ticked bills oldest first and pays each in turn. Whatever is left becomes an advance. The same rule the server uses. */
export function breakdown(bills: OpenBill[], ticked: Set<string>, amountPaise: number) {
  let left = amountPaise;
  const lines: { bill: OpenBill; payPaise: number }[] = [];
  for (const bill of bills) {
    if (!ticked.has(bill.documentId) || left <= 0) continue;
    const pay = Math.min(left, bill.balancePaise);
    lines.push({ bill, payPaise: pay });
    left -= pay;
  }
  return { lines, advancePaise: Math.max(0, left) };
}

/** The family strip: every child of the same parent, with what each owes. Tap a child to add or remove their bills. */
function FamilyStrip({ guardianPersonId, included, onToggle }: { guardianPersonId: string; included: Child[]; onToggle: (c: Child) => void }) {
  const family = useFamily(guardianPersonId);
  const kids = family.data?.children ?? [];
  if (kids.length < 2) return null;
  return (
    <section aria-label="Family" className="rounded-xl border border-line bg-canvas px-3 py-2">
      <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-muted">
        <UsersRound className="size-4" aria-hidden="true" /> {family.data?.guardianName}’s children · total due {formatMoney(family.data?.totals.outstandingPaise ?? 0)}
      </p>
      <div className="flex flex-wrap gap-2">
        {kids.map((k) => {
          const on = included.some((c) => c.studentId === k.studentId);
          return (
            <button
              key={k.studentId}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle({ studentId: k.studentId, studentName: k.studentName, className: k.className })}
              className={cn('rounded-lg border px-3 py-1.5 text-left text-sm', on ? 'border-brand bg-brand text-white' : 'border-line bg-white hover:border-brand/40')}
            >
              <b>{k.studentName}</b> <span className={on ? 'text-white/80' : 'text-muted'}>· {formatMoney(k.outstandingPaise)} due</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Cash needs an open shift. When there is none, the step to open one sits right here: no page change. */
export function OpenShiftStep() {
  const cash = useCashAccounts();
  const [float, setFloat] = useState<number | null>(0);
  const [cashId, setCashId] = useState('');
  const open = useFinanceMutation((body: { openingFloatPaise: number; cashAccountId?: string }) => collectApi.openShift(body), { success: 'Your shift is open. You can take cash now.' });
  const accounts = (cash.data ?? []).filter((c) => c.status === 'ACTIVE');
  return (
    <section aria-label="Open your shift" className="space-y-3 rounded-xl border border-sun/50 bg-sun-soft px-4 py-3">
      <p className="text-sm">
        <b>Open your shift first.</b> Count the cash already in the drawer (the float) and enter it. At the end of the day you count again.
      </p>
      {accounts.length === 0 && !cash.isLoading ? (
        <Alert tone="warning">There is no cash account yet. Ask the accountant to add one in Finance Settings → Bank & Cash.</Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyField label="Cash in the drawer now" value={float} onChange={setFloat} hint="Enter 0 if the drawer is empty." />
          {accounts.length > 1 && (
            <ComboboxField label="Cash box" value={cashId} onChange={setCashId} placeholder="Choose…" searchPlaceholder="Search cash boxes…" options={accounts.map((a) => ({ value: a.cashAccountId, label: a.label }))} />
          )}
        </div>
      )}
      <Button size="sm" disabled={float === null || accounts.length === 0} loading={open.isPending} loadingText="Opening…" onClick={() => open.mutate({ openingFloatPaise: float ?? 0, ...(cashId ? { cashAccountId: cashId } : {}) })}>
        Open Shift
      </Button>
    </section>
  );
}

/**
 * Take Payment (FUX-06): one workspace. Find the student (or the family), see the open bills, pick the method and the amount, watch
 * the live breakdown, press one button. The result card replaces the form. Pressing twice saves once: the same idempotency key is
 * sent until the person starts the next payment.
 */
export function TakePayment() {
  const ctx = useStudentContext();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 300);
  const search = useAccounts({ locationId: ctx.locationId, academicSessionId: ctx.sessionId, q: q || undefined });

  const [children, setChildren] = useState<Child[]>([]);
  const [guardianId, setGuardianId] = useState<string | null>(params.get('guardian'));
  const preset = params.get('student');
  const [presetDone, setPresetDone] = useState(false);
  // Opened from a student's account ("Collect"): start with that student. The family strip needs the parent, passed as `guardian`.
  const presetAccount = useStudentAccount(preset && !presetDone ? preset : undefined);
  if (preset && !presetDone && children.length === 0 && presetAccount.data) {
    setPresetDone(true);
    setChildren([{ studentId: presetAccount.data.studentId, studentName: presetAccount.data.studentName, className: presetAccount.data.className }]);
  }

  const bills = useQueries({
    queries: children.map((c) => ({
      queryKey: [...FIN, 'bills', c.studentId],
      queryFn: () => api.get<FeeDocumentListDTO>(`/finance/fee-documents${qs({ studentId: c.studentId, pageSize: 100 })}`),
    })),
  });
  const open: OpenBill[] = useMemo(
    () =>
      bills
        .flatMap((b) => b.data?.items ?? [])
        .filter((d) => d.balancePaise > 0 && d.kind !== 'CREDIT_NOTE' && d.status !== 'CANCELLED')
        .map((d) => ({ documentId: d.documentId, number: d.number, studentId: d.studentId, studentName: d.studentName, dueDate: d.dueDate, balancePaise: d.balancePaise, overdue: d.overdue }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)),
    [bills],
  );
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = useMemo(() => new Set(open.filter((b) => !unticked.has(b.documentId)).map((b) => b.documentId)), [open, unticked]);
  const dueTicked = open.filter((b) => ticked.has(b.documentId)).reduce((s, b) => s + b.balancePaise, 0);

  const [method, setMethod] = useState<Method>('CASH');
  const [typed, setTyped] = useState<number | null | undefined>(undefined);
  const amount = typed === undefined ? dueTicked : typed;
  const [payer, setPayer] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [bankId, setBankId] = useState('');
  const [cheque, setCheque] = useState({ number: '', bankName: '', chequeDate: todayLocal() });
  const [result, setResult] = useState<CollectionResultDTO | null>(null);
  const [error, setError] = useState<unknown>(null);
  const key = useRef(newKey());

  const shift = useMyShift(can('finance:cashier:shift'));
  const banks = useBankAccounts();
  const activeBanks = (banks.data ?? []).filter((b) => b.status === 'ACTIVE');
  const bank = bankId || activeBanks.find((b) => b.purpose === 'FEES')?.bankAccountId || activeBanks[0]?.bankAccountId || '';

  const save = useFinanceMutation((vars: { body: Record<string, unknown>; verify: boolean }) => collectApi.create(vars.body, key.current), { quiet: true });
  const verify = useFinanceMutation((vars: { id: string; body: Record<string, unknown> }) => collectApi.verify(vars.id, vars.body), { quiet: true });

  const plan = breakdown(open, ticked, amount ?? 0);
  const isBank = method === 'UPI' || method === 'NEFT';
  const needsShift = method === 'CASH' && !shift.isLoading && !shift.data;
  const chequeReady = method !== 'CHEQUE' || (cheque.number.trim() && cheque.bankName.trim() && cheque.chequeDate);
  const ready = children.length > 0 && (amount ?? 0) > 0 && (!isBank || (reference.trim() && paidOn)) && chequeReady && !needsShift;

  const reset = () => {
    key.current = newKey();
    setResult(null);
    setError(null);
    setTyped(undefined);
    setReference('');
    setPayer('');
    setUnticked(new Set());
    setCheque({ number: '', bankName: '', chequeDate: todayLocal() });
    setChildren([]);
    setGuardianId(null);
    setText('');
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.delete('student');
      n.delete('guardian');
      return n;
    });
  };

  const pick = (row: StudentAccountRowDTO) => {
    setChildren([{ studentId: row.studentId, studentName: row.studentName, className: row.className }]);
    setGuardianId(row.guardianPersonId);
    setTyped(undefined);
    setUnticked(new Set());
    setText('');
  };

  // A second click while the first is still saving does nothing; a retry after a network error reuses the same key, so the server saves once.
  const inFlight = useRef(false);
  const submit = async (andVerify: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const body: Record<string, unknown> = {
      method,
      amountPaise: amount,
      ...(payer.trim() ? { payerName: payer.trim() } : {}),
      ...(isBank ? { reference: reference.trim(), receivedOn: paidOn, ...(bank ? { bankAccountId: bank } : {}) } : {}),
      ...(method === 'CHEQUE' ? { cheque: { number: cheque.number.trim(), bankName: cheque.bankName.trim(), chequeDate: cheque.chequeDate, ...(payer.trim() ? { payerName: payer.trim() } : {}) } } : {}),
      allocations: plan.lines.map((l) => ({ studentId: l.bill.studentId, documentId: l.bill.documentId, amountPaise: l.payPaise })),
      advanceStudentId: children[0]!.studentId,
    };
    try {
      let res = await save.mutateAsync({ body, verify: andVerify });
      if (andVerify && res.collection.status === 'PENDING_VERIFICATION') {
        res = await verify.mutateAsync({ id: res.collection.collectionId, body: { amountSeenPaise: res.collection.amountPaise, evidence: { seenOn: todayLocal(), note: 'Checked at the counter' }, ...(bank ? { bankAccountId: bank } : {}) } });
      }
      setResult(res);
    } catch (e) {
      setError(e);
    } finally {
      inFlight.current = false;
    }
  };

  if (result) return <PaymentResultCard result={result} onNext={reset} />;

  return (
    <div className="space-y-4">
      <TabIntro title="Take Payment">{TAKE_PAYMENT_INTRO}</TabIntro>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Who is paying?</CardTitle>
            </CardHeader>
            {children.length === 0 ? (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <Input aria-label="Find a student" className="pl-10" placeholder="Name, admission number, parent name or phone…" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
                </div>
                {q.length >= 2 && (
                  <ul className="mt-2 divide-y divide-line rounded-xl border border-line" aria-label="Students found">
                    {search.isLoading && <li className="p-3"><Skeleton className="h-8" /></li>}
                    {search.data?.items.length === 0 && <li className="p-3 text-sm text-muted">No student matches “{q}”. Try the admission number.</li>}
                    {search.data?.items.slice(0, 8).map((r) => (
                      <li key={r.studentId}>
                        <button type="button" className="flex w-full flex-wrap items-center gap-x-3 px-3 py-2.5 text-left text-sm hover:bg-canvas" onClick={() => pick(r)}>
                          <b>{r.studentName}</b>
                          <span className="text-muted">{[r.admissionNumber, r.className, r.guardianName].filter(Boolean).join(' · ')}</span>
                          <span className="ml-auto">{r.outstandingPaise > 0 ? <>Due <Money paise={r.outstandingPaise} strong /></> : <span className="text-success">Nothing due</span>}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {children.map((c) => (
                    <span key={c.studentId} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-3 py-1.5 text-sm">
                      <b>{c.studentName}</b> <span className="text-muted">{c.className}</span>
                    </span>
                  ))}
                  <Button size="sm" variant="ghost" onClick={reset}>
                    <X /> Change Student
                  </Button>
                </div>
                {guardianId && (
                  <FamilyStrip
                    guardianPersonId={guardianId}
                    included={children}
                    onToggle={(c) => {
                      setTyped(undefined);
                      setChildren((prev) => (prev.some((p) => p.studentId === c.studentId) ? (prev.length > 1 ? prev.filter((p) => p.studentId !== c.studentId) : prev) : [...prev, c]));
                    }}
                  />
                )}
              </div>
            )}
          </Card>

          {children.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-1.5">
                  Open bills <InfoTip label="About paying bills">{TIP_ALLOCATE}</InfoTip>
                </CardTitle>
              </CardHeader>
              {bills.some((b) => b.isLoading) ? (
                <Skeleton className="h-20" />
              ) : open.length === 0 ? (
                <p className="text-sm text-muted">No bills are waiting. A payment now is kept as an advance for the next bill.</p>
              ) : (
                <ul className="divide-y divide-line" aria-label="Open bills">
                  {open.map((b) => (
                    <li key={b.documentId}>
                      <label className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-5 accent-[var(--color-brand)]"
                          checked={ticked.has(b.documentId)}
                          onChange={(e) => {
                            setTyped(undefined);
                            setUnticked((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.delete(b.documentId);
                              else n.add(b.documentId);
                              return n;
                            });
                          }}
                          aria-label={`Pay ${b.number}`}
                        />
                        <b>{b.number}</b>
                        {children.length > 1 && <span>{b.studentName}</span>}
                        <span className={b.overdue ? 'font-semibold text-danger' : 'text-muted'}>Due {formatDateOnly(b.dueDate)}{b.overdue ? ' · late' : ''}</span>
                        <Money paise={b.balancePaise} strong className="ml-auto" />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {children.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>How did they pay?</CardTitle>
              </CardHeader>
              <div className="space-y-4">
                <ChoiceCards<Method>
                  label="Payment method"
                  value={method}
                  onChange={(m) => {
                    setMethod(m);
                    setError(null);
                  }}
                  options={[
                    { value: 'CASH', label: 'Cash', hint: 'Receipt at once', Icon: Banknote },
                    { value: 'UPI', label: 'UPI', hint: 'Waits for a check', Icon: Smartphone },
                    { value: 'NEFT', label: 'Bank Transfer', hint: 'Waits for a check', Icon: Building2 },
                    { value: 'CHEQUE', label: 'Cheque', hint: 'Receipt after it clears', Icon: FileCheck2 },
                  ]}
                />
                {needsShift && <OpenShiftStep />}
                <div className="grid gap-3 sm:grid-cols-2">
                  <MoneyField label="Amount received" value={amount} onChange={(v) => setTyped(v)} required hint={`Total of the ticked bills: ${formatMoney(dueTicked)}`} />
                  <TextField label="Paid by" value={payer} onChange={(e) => setPayer(e.target.value)} hint="Optional. The parent’s name, for the receipt." maxLength={100} />
                </div>
                {isBank && (
                  <>
                    <Alert tone="info">This will wait for verification. The receipt comes after someone sees the money in the bank.</Alert>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <TextField label="Date paid" type="date" required value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} />
                      <TextField label="Reference (UTR)" required value={reference} onChange={(e) => setReference(e.target.value)} hint="From the parent’s payment screen." maxLength={60} />
                      <ComboboxField label="Into bank account" value={bank} onChange={setBankId} searchPlaceholder="Search accounts…" options={activeBanks.map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} />
                    </div>
                  </>
                )}
                {method === 'CHEQUE' && (
                  <>
                    <Alert tone="info">A receipt is made only after the cheque clears. Until then the family gets an acknowledgement.</Alert>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <TextField label="Cheque number" required value={cheque.number} onChange={(e) => setCheque({ ...cheque, number: e.target.value })} maxLength={20} />
                      <TextField label="Bank" required value={cheque.bankName} onChange={(e) => setCheque({ ...cheque, bankName: e.target.value })} hint="Example: HDFC Bank" maxLength={80} />
                      <TextField label="Cheque date" type="date" required value={cheque.chequeDate} onChange={(e) => setCheque({ ...cheque, chequeDate: e.target.value })} />
                    </div>
                  </>
                )}
              </div>
            </Card>
          )}
        </div>

        {children.length > 0 && (
          <aside aria-label="Where the money goes" className="h-fit space-y-3 rounded-card border border-line bg-white p-4 shadow-card lg:sticky lg:top-24">
            <h2 className="text-base font-bold">Where the money goes</h2>
            {plan.lines.length === 0 && plan.advancePaise === 0 ? (
              <p className="text-sm text-muted">Enter an amount to see which bills it pays.</p>
            ) : (
              <ul className="space-y-1.5 text-sm" aria-label="Breakdown" aria-live="polite">
                {plan.lines.map((l) => (
                  <li key={l.bill.documentId} className="flex justify-between gap-3">
                    <span>
                      {l.bill.number}
                      {children.length > 1 && <span className="text-muted"> · {l.bill.studentName.split(' ')[0]}</span>}
                      {l.payPaise < l.bill.balancePaise && <span className="text-muted"> (part)</span>}
                    </span>
                    <Money paise={l.payPaise} />
                  </li>
                ))}
              </ul>
            )}
            {plan.advancePaise > 0 && (
              <p className="flex items-start gap-1 rounded-lg bg-brand-soft px-3 py-2 text-sm" data-testid="advance-note">
                {formatMoney(plan.advancePaise)} will be kept as advance. <InfoTip label="About advance">{TIP_ADVANCE}</InfoTip>
              </p>
            )}
            <p className="flex justify-between border-t border-line pt-2 text-[15px] font-bold">
              <span>Total</span>
              <span>{formatMoney(amount ?? 0)}</span>
            </p>
            {error !== null && <ErrorBanner error={error} />}
            <Button className="w-full" disabled={!ready} loading={save.isPending && !verify.isPending} loadingText="Saving…" onClick={() => void submit(false)}>
              Save Payment
            </Button>
            {isBank && (
              <Can permission="finance:collection:verify">
                <Button className="w-full" variant="outline" disabled={!ready || save.isPending} loading={verify.isPending} loadingText="Checking…" onClick={() => void submit(true)}>
                  Save And Verify
                </Button>
                <p className="text-xs text-muted">Use Save And Verify only if you can see this money in the bank right now.</p>
              </Can>
            )}
            {needsShift && <p className="text-xs text-muted">Open your shift above to take cash.</p>}
          </aside>
        )}
      </div>
    </div>
  );
}
