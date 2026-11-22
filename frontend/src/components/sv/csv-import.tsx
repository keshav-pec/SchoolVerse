import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, CircleCheck, FileCheck2, FileSpreadsheet, FileUp } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { Pager } from '@/components/sv/pager';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

/**
 * The pieces shared by every CSV import screen (rooms, students): the file picker, the list of earlier uploads, the column matching
 * step, and the paged list of rows. Each screen keeps its own wording, API calls and summary.
 */

interface QueryState {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
}

/** The “CSV file” picker with its hint underneath. */
export function CsvFileField({ id, hint, onFile }: { id: string; hint: ReactNode; onFile: (file: File | null) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        CSV file
      </label>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-4 file:py-2.5 file:font-semibold file:text-brand"
      />
      <p className="text-[13px] text-muted">{hint}</p>
    </div>
  );
}

export interface EarlierImport {
  importId: string;
  fileName: string;
  createdAt: string;
  message: string;
  statusText: string;
  committed: boolean;
  href: string;
}

/** “Earlier imports”: every upload, so people can come back and finish it. */
export function EarlierImportsCard({ query, items }: { query: QueryState; items: EarlierImport[] }) {
  return (
    <Card className="p-0" aria-label="Earlier imports">
      <h2 className="border-b border-line px-4 py-3 text-base font-bold">Earlier imports</h2>
      {query.isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState illustration={<FileSpreadsheet className="size-12 text-muted" aria-hidden="true" />} title="No imports yet" description="Files you upload show here, so you can come back and finish them." />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.importId} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <FileUp className="size-5 text-brand" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{i.fileName}</p>
                <p className="text-[13px] text-muted">
                  {formatDateTime(i.createdAt)} · {i.message}
                </p>
              </div>
              <Badge tone={i.committed ? 'success' : 'warning'}>{i.statusText}</Badge>
              <Button asChild size="sm" variant="outline">
                <Link to={i.href}>Open</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The “← Imports” link above one import. */
export function ImportsBackLink({ to }: { to: string }) {
  return (
    <Link to={to} className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
      <ArrowLeft className="size-4" /> Imports
    </Link>
  );
}

/** Step 1: the columns we matched by ourselves, and a picker only for the ones we could not match. */
export function ColumnMappingStep<F extends string>({
  fields,
  labels,
  required,
  matched: initial,
  headers,
  noun,
  onCheck,
  checking,
}: {
  fields: readonly F[];
  labels: Record<F, string>;
  required: readonly F[];
  /** What the server matched on upload. */
  matched: Partial<Record<F, string | null>>;
  headers: string[];
  /** “room”, “student”: used in “Every room needs them.” */
  noun: string;
  onCheck: (mapping: Partial<Record<F, string | null>>) => Promise<unknown>;
  checking: boolean;
}) {
  const [mapping, setMapping] = useState(initial);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matched = fields.filter((f) => initial[f]);
  const shown = showAll ? fields : fields.filter((f) => !initial[f]);
  const missing = required.filter((f) => !mapping[f]);
  const options = [{ value: '', label: 'Not in the file' }, ...headers.map((h) => ({ value: h, label: h }))];

  return (
    <Card className="space-y-4" aria-label="Match the columns">
      <CardHeader className="mb-0">
        <CardTitle className="text-lg">1. Match the columns</CardTitle>
      </CardHeader>
      <Alert tone={matched.length > 0 ? 'success' : 'info'}>
        We matched {matched.length} of {fields.length} columns by ourselves{matched.length > 0 ? `: ${matched.map((f) => `${labels[f]} ← “${initial[f]}”`).join(', ')}` : ''}. Only fix the ones below.
      </Alert>
      {shown.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleCheck className="size-4 text-success" aria-hidden="true" /> Every column is matched.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Columns to match">
          {shown.map((f) => (
            <li key={f} className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm font-semibold">
                {labels[f]}
                {required.includes(f) && <span className="text-danger"> *</span>}
              </span>
              <Combobox aria-label={`File column for ${labels[f]}`} className="h-9 flex-1" value={mapping[f] ?? ''} onChange={(v) => setMapping((m) => ({ ...m, [f]: v || null }))} options={options} searchPlaceholder="Search columns…" />
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
        {showAll ? 'Show only unmatched columns' : 'Change a matched column'}
      </Button>
      {missing.length > 0 && (
        <Alert tone="warning">
          Match {missing.map((f) => labels[f]).join(' and ')} before checking. Every {noun} needs them.
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        disabled={missing.length > 0}
        loading={checking}
        loadingText="Checking every row…"
        onClick={async () => {
          setError(null);
          try {
            await onCheck(mapping);
          } catch (err) {
            setError(messageFor(err));
          }
        }}
      >
        <FileCheck2 /> Check The File
      </Button>
    </Card>
  );
}

export interface IssueGroup {
  code: string;
  title: string;
  count: number;
  fix: ReactNode;
  badge: ReactNode;
}

/** “Problems by kind”: one line per kind of problem, with how to fix it. */
export function IssueGroupsCard({ groups, query, action }: { groups: IssueGroup[]; query?: QueryState; action?: ReactNode }) {
  return (
    <Card className="p-0" aria-label="Problems by kind">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-base font-bold">Problems by kind</h2>
        {action}
      </div>
      {query?.isLoading ? (
        <Skeleton className="m-4 h-16" />
      ) : query?.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : groups.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
          <CircleCheck className="size-4 text-success" aria-hidden="true" /> No problems found.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {groups.map((g) => (
            <li key={g.code} className="space-y-1 px-4 py-3" data-testid="issue-group">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {g.badge}
                {g.title}
                <span className="font-normal text-muted">
                  · {g.count} row{g.count === 1 ? '' : 's'}
                </span>
              </p>
              <p className="text-[13px] text-muted">Fix: {g.fix}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** “Show all rows” / “Show only problem rows” and the page, for the rows query. */
export function useImportRowFilter() {
  const [allRows, setAllRows] = useState(false);
  const [page, setPage] = useState(1);
  return {
    allRows,
    page,
    setPage,
    toggle: () => {
      setAllRows((v) => !v);
      setPage(1);
    },
    args: { status: allRows ? undefined : ('NEEDS_ATTENTION' as const), page },
  };
}

export type ImportRowStatus = 'READY' | 'IMPORTED' | 'NEEDS_ATTENTION' | 'SKIPPED';
const ROW_BADGE = { READY: ['success', 'Ready'], IMPORTED: ['success', 'Imported'], NEEDS_ATTENTION: ['warning', 'Needs attention'], SKIPPED: ['neutral', 'Skipped'] } as const;

export interface ImportRowLine {
  rowId: string;
  rowNumber: number;
  status: ImportRowStatus;
  name: string;
  detail: ReactNode;
  /** Where the imported record opens, once there is one. */
  link?: { to: string; label: string } | null;
  issues: { title: string; fix: string; strong: boolean }[];
}

/** The rows of the file: only the ones that need attention, or all of them, a page at a time. */
export function ImportRowsCard({
  filter,
  query,
  data,
}: {
  filter: ReturnType<typeof useImportRowFilter>;
  query: QueryState;
  data?: { items: ImportRowLine[]; total: number; pageSize: number };
}) {
  const { allRows, page, setPage, toggle } = filter;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const items = data?.items ?? [];
  return (
    <Card className="p-0" aria-label="Rows">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <h2 className="flex-1 text-base font-bold">{allRows ? 'All rows' : 'Rows that need attention'}</h2>
        <Button variant="ghost" size="sm" onClick={toggle}>
          {allRows ? 'Show only problem rows' : 'Show all rows'}
        </Button>
      </div>
      {query.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">{allRows ? 'No rows.' : 'No row needs attention.'}</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {items.map((r) => {
              const [tone, text] = ROW_BADGE[r.status];
              return (
                <li key={r.rowId} className="px-4 py-2.5 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">Row {r.rowNumber}</span>
                    <span className="font-semibold">{r.name || 'No name'}</span>
                    <span className="text-muted">{r.detail}</span>
                    <Badge tone={tone}>{text}</Badge>
                    {r.link && (
                      <Link to={r.link.to} className="text-brand hover:underline">
                        {r.link.label}
                      </Link>
                    )}
                  </p>
                  {r.issues.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
                      {r.issues.map((i, ix) => (
                        <li key={ix}>
                          <span className={i.strong ? 'font-semibold text-danger' : undefined}>{i.title}</span> {i.fix}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          {pages > 1 && (
            <div className="flex justify-end border-t border-line px-4 py-2">
              <Pager page={page} pages={pages} onPage={setPage} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
