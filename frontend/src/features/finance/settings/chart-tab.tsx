import { useMemo, useState } from 'react';
import { Lock, Plus, Search, Wand2 } from 'lucide-react';
import { ACCOUNT_TYPES, type AccountDTO, type AccountType } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { messageFor } from '@/lib/errors';
import { financeApi, useChart, useFinanceMutation, useStandardSetup } from '../api';
import { ACCOUNT_TYPE_LABELS, CHART_INTRO } from '../help-copy';

interface Node {
  account: AccountDTO;
  depth: number;
}

/** The accounts as a simple tree: each group with the accounts under it. */
function flatten(accounts: AccountDTO[]): Node[] {
  const byParent = new Map<string | null, AccountDTO[]>();
  const ids = new Set(accounts.map((a) => a.accountId));
  for (const a of accounts) {
    const key = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  const out: Node[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      out.push({ account: a, depth });
      walk(a.accountId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Chart of Accounts: where every rupee is recorded. System accounts are locked, with the reason. */
export function ChartTab() {
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 250);
  const chart = useChart(q || undefined);
  const all = useChart();
  const standard = useStandardSetup();
  const [adding, setAdding] = useState(false);
  const toggle = useFinanceMutation((a: AccountDTO) => financeApi.updateAccount(a.accountId, { status: a.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }), { quiet: true });
  const [error, setError] = useState<string | null>(null);
  const nodes = useMemo(() => flatten(chart.data ?? []), [chart.data]);
  const empty = all.data?.length === 0;

  return (
    <div className="space-y-4">
      <TabIntro title="Chart of Accounts" need="required">
        {CHART_INTRO}
      </TabIntro>
      <Card>
        <CardHeader>
          <HelpHeading title="Accounts" help={<p>Accounts with a lock are used by the system by itself, for example Student Fees Receivable. They cannot be switched off or moved.</p>} />
          <div className="flex flex-wrap gap-2">
            <Can permission="finance:setup:manage">
              <Button variant={empty ? 'default' : 'outline'} onClick={() => standard.mutate()} loading={standard.isPending} loadingText="Setting up…">
                <Wand2 /> Use The Standard Chart
              </Button>
              <Button variant="outline" onClick={() => setAdding(true)}>
                <Plus /> Add Account
              </Button>
            </Can>
          </div>
        </CardHeader>
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <Input aria-label="Search accounts" className="pl-9" placeholder="Search by name or code…" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {error && (
          <Alert tone="danger" className="mb-3">
            {error}
          </Alert>
        )}
        {chart.isLoading && <Skeleton className="h-48" role="status" aria-label="Loading" />}
        {chart.isError && <ErrorState error={chart.error} onRetry={() => void chart.refetch()} retrying={chart.isFetching} />}
        {empty && <EmptyState title="No accounts yet" description="Press “Use The Standard Chart” to add a chart made for schools. You can add more accounts later." />}
        {!empty && nodes.length === 0 && !chart.isLoading && <p className="text-sm text-muted">No account matches “{q}”.</p>}
        <ul className="divide-y divide-line" aria-label="Accounts">
          {nodes.map(({ account: a, depth }) => (
            <li key={a.accountId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm" style={{ paddingLeft: `${depth * 20}px` }}>
              <span className="w-12 shrink-0 font-mono text-[13px] text-muted">{a.code}</span>
              <span className={`min-w-0 flex-1 ${a.isPostable ? '' : 'font-bold'}`}>
                {a.name}
                {!a.isPostable && <span className="ml-2 text-[13px] font-normal text-muted">group</span>}
              </span>
              <span className="text-[13px] text-muted">{ACCOUNT_TYPE_LABELS[a.type]}</span>
              {a.systemRole && (
                <Tooltip content="The system posts to this account by itself, so it cannot be switched off or moved.">
                  <span tabIndex={0} className="inline-flex items-center gap-1 rounded-pill bg-ink/6 px-2 py-1 text-xs font-semibold" aria-label="System account, locked">
                    <Lock className="size-3" aria-hidden="true" /> System
                  </span>
                </Tooltip>
              )}
              {a.status === 'INACTIVE' && <FinanceStatusPill status="INACTIVE" />}
              {!a.systemRole && a.isPostable && (
                <Can permission="finance:setup:manage">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      setError(null);
                      try {
                        await toggle.mutateAsync(a);
                      } catch (e) {
                        setError(messageFor(e));
                      }
                    }}
                    aria-label={`${a.status === 'ACTIVE' ? 'Switch off' : 'Switch on'} ${a.name}`}
                  >
                    {a.status === 'ACTIVE' ? 'Switch Off' : 'Switch On'}
                  </Button>
                </Can>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[13px] text-muted">An account that has entries is never deleted. It can only be switched off.</p>
      </Card>
      <AddAccount open={adding} onClose={() => setAdding(false)} accounts={all.data ?? []} />
    </div>
  );
}

function AddAccount({ open, onClose, accounts }: { open: boolean; onClose: () => void; accounts: AccountDTO[] }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('EXPENSE');
  const [parentId, setParentId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useFinanceMutation((body: Record<string, unknown>) => financeApi.createAccount(body), { success: 'Account added.', quiet: true });
  const parents = accounts.filter((a) => a.type === type && a.status === 'ACTIVE' && !a.systemRole);
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Add an account" description="A new account goes under a group of the same kind.">
      <div className="space-y-3">
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Sports Fee Income." maxLength={100} />
        <ComboboxField
          label="Kind"
          value={type}
          onChange={(v) => {
            setType(v as AccountType);
            setParentId('');
          }}
          options={ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_TYPE_LABELS[t] ?? t }))}
          searchPlaceholder="Search…"
        />
        <ComboboxField label="Goes under" required value={parentId} onChange={setParentId} placeholder="Choose a group…" searchPlaceholder="Search groups…" options={parents.map((a) => ({ value: a.accountId, label: a.name, hint: a.code }))} />
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value)} hint="Optional. Leave empty and we will suggest one." maxLength={12} />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim() === '' || parentId === ''}
            loading={add.isPending}
            loadingText="Adding…"
            onClick={async () => {
              setError(null);
              try {
                await add.mutateAsync({ name: name.trim(), type, parentId, ...(code.trim() ? { code: code.trim() } : {}) });
                setName('');
                setCode('');
                onClose();
              } catch (e) {
                setError(messageFor(e));
              }
            }}
          >
            Add Account
          </Button>
        </div>
      </div>
    </Modal>
  );
}
