import { EMPLOYEE_CATEGORY_LABELS } from '@shared';
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Mail,
  Phone,
  Search,
  SearchX,
  UsersRound,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { useListParams } from '@/hooks/use-list-params';
import { formatPhone } from '@/lib/format';
import { useEmployees } from './api';

const PAGE_SIZE = 12;

/** `/colleagues`: directory fields only, for people who share a location with you. */
export function ColleaguesPage() {
  // Search and page live in the URL, like the other lists, so Back returns to the same page.
  const { params, setParam, page, search, setSearch } = useListParams();
  const q = params.get('q') ?? '';
  const setPage = (next: number) => setParam({ page: String(next) }, true);
  const list = useEmployees({ q: q || undefined, page, pageSize: PAGE_SIZE });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Colleagues"
        description="People who work at the same location as you. You see their work details only."
      />
      <div className="relative mb-5 max-w-md">
        <Search
          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name"
          aria-label="Search colleagues"
          className="pl-10"
        />
      </div>

      {list.isLoading ? (
        <div
          role="status"
          aria-label="Loading colleagues"
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-card" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : total === 0 ? (
        <EmptyState
          illustration={
            q ? (
              <SearchX className="size-12 text-muted" aria-hidden="true" />
            ) : (
              <UsersRound className="size-12 text-muted" aria-hidden="true" />
            )
          }
          title={q ? 'No one matches that name' : 'No colleagues to show yet'}
          description={
            q
              ? undefined
              : 'You will see people here once you are placed at a location that others share.'
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Colleagues">
            {list.data!.items.map((c) => (
              <li
                key={c.employeeId}
                className="rounded-card border border-line bg-white p-5 shadow-card"
              >
                <div className="flex items-center gap-3">
                  <Avatar name={c.fullName} className="size-11" />
                  <div className="min-w-0">
                    <p className="truncate font-bold">{c.displayName}</p>
                    <p className="truncate text-[13px] text-muted">{c.designation.name}</p>
                  </div>
                </div>
                <dl className="mt-4 space-y-1.5 text-sm">
                  <div className="flex items-center gap-2 text-muted">
                    <Building2 className="size-4 shrink-0" aria-hidden="true" />
                    <dt className="sr-only">Department</dt>
                    <dd>
                      {c.department.name} · {EMPLOYEE_CATEGORY_LABELS[c.employeeCategory]}
                    </dd>
                  </div>
                  {c.officialEmail && (
                    <div className="flex items-center gap-2">
                      <Mail className="size-4 shrink-0 text-muted" aria-hidden="true" />
                      <dt className="sr-only">Email</dt>
                      <dd className="min-w-0 truncate">
                        <a
                          href={`mailto:${c.officialEmail}`}
                          className="text-brand hover:underline"
                        >
                          {c.officialEmail}
                        </a>
                      </dd>
                    </div>
                  )}
                  {c.officialPhone && (
                    <div className="flex items-center gap-2">
                      <Phone className="size-4 shrink-0 text-muted" aria-hidden="true" />
                      <dt className="sr-only">Phone</dt>
                      <dd>{formatPhone(c.officialPhone)}</dd>
                    </div>
                  )}
                  {c.locations.length > 0 && (
                    <p className="pt-1 text-[13px] text-muted">
                      {c.locations.map((l) => l.displayName).join(', ')}
                    </p>
                  )}
                </dl>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex items-center justify-between text-sm text-muted">
            <p aria-live="polite">
              {total} {total === 1 ? 'colleague' : 'colleagues'}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
