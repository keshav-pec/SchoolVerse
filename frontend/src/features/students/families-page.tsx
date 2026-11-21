import { Link, useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight, Search, SearchX, UsersRound, X } from 'lucide-react';
import type { FamilySummaryDTO } from '@shared';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useListParams } from '@/hooks/use-list-params';
import { formatPhone } from '@/lib/format';
import { useFamilies } from './api';
import { FAMILIES_INTRO } from './help-copy';

const PAGE_SIZE = 20;

function Children({ family }: { family: FamilySummaryDTO }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {family.children.map((c) => (
        <Link key={c.studentId} to={`/students/${c.studentId}`} className="rounded-pill bg-brand-soft px-2.5 py-0.5 text-[13px] font-semibold text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
          {c.fullName}
        </Link>
      ))}
    </span>
  );
}

/** `/families`: every parent, with all their children in one row. */
export function FamiliesPage() {
  const navigate = useNavigate();
  const { params, setParam, page, search, setSearch, clearAll } = useListParams();
  const q = params.get('q') ?? undefined;
  const list = useFamilies({ q, page, pageSize: PAGE_SIZE });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader eyebrow="Students" title="Families" description="Each parent once, with every child linked to them." />
      <TabIntro title="About families" className="mb-4">
        {FAMILIES_INTRO}
      </TabIntro>
      <Card className="p-0">
        <div className="border-b border-line p-4">
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search parent name, phone or child" aria-label="Search families" className="pl-10" />
          </div>
        </div>
        {list.isLoading ? (
          <div className="divide-y divide-line" role="status" aria-label="Loading families">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 p-4">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-4 w-48" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : total === 0 && !q ? (
          <EmptyState illustration={<UsersRound className="size-14 text-brand" aria-hidden="true" />} title="No families yet" description="Parents appear here once you add a student with a parent." action={<Button onClick={() => navigate('/students/new')}>Add Your First Student</Button>} />
        ) : total === 0 ? (
          <EmptyState
            illustration={<SearchX className="size-14 text-muted" aria-hidden="true" />}
            title="No parent matches your search"
            description="Try a different name or phone number."
            action={
              <Button variant="outline" onClick={clearAll}>
                <X /> Clear Search
              </Button>
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-line" aria-label="Families">
              {list.data!.items.map((f) => (
                <li key={f.personId} className="flex cursor-pointer flex-col gap-2 p-4 hover:bg-canvas/60 sm:flex-row sm:items-center sm:gap-4" onClick={() => navigate(`/families/${f.personId}`)}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={f.fullName} />
                    <div className="min-w-0">
                      <Link to={`/families/${f.personId}`} className="block truncate font-semibold text-ink hover:text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
                        {f.fullName}
                      </Link>
                      <p className="text-xs text-muted">{[f.phone ? formatPhone(f.phone) : null, f.email].filter(Boolean).join(' · ') || 'No contact shown'}</p>
                    </div>
                  </div>
                  <div className="sm:max-w-[50%]">
                    <p className="mb-1 text-xs text-muted">
                      {f.childCount} {f.childCount === 1 ? 'child' : 'children'}
                    </p>
                    <Children family={f} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <p aria-live="polite">
                {total} {total === 1 ? 'family' : 'families'}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) }, true)} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <span>
                  Page {page} of {pages}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setParam({ page: String(page + 1) }, true)} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
