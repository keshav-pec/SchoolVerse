import { useState } from 'react';
import { Link } from 'react-router';
import { LOCATION_STATUSES, LOCATION_STATUS_LABELS, LOCATION_TYPES, LOCATION_TYPE_LABELS, type LocationStatus } from '@shared';
import { ChevronLeft, ChevronRight, Info, Plus, Search, SearchX, X } from 'lucide-react';
import { EmptyMap } from '@/components/illustrations/empty-map';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { useListParams } from '@/hooks/use-list-params';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useCurrentSchool } from '../school-profile/api';
import { AddLocationDrawer } from './add-location-drawer';
import { useLocations, type LocationListParams } from './api';
import { LocationTable } from './location-table';

const PAGE_SIZE = 20;

function isStatus(v: string | null): v is LocationStatus {
  return !!v && (LOCATION_STATUSES as readonly string[]).includes(v);
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-line" role="status" aria-label="Loading locations">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="size-9 rounded-[10px]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="hidden h-6 w-20 md:block" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

export function LocationsPage() {
  const { can } = useAuth();
  const school = useCurrentSchool();
  const { params, setParam, page, search, setSearch, clearAll } = useListParams();
  const [adding, setAdding] = useState(false);

  const statusParam = params.get('status');
  const filters: LocationListParams = {
    q: params.get('q') ?? undefined,
    status: isStatus(statusParam) ? statusParam : undefined,
    type: params.get('type') ?? undefined,
    city: params.get('city') ?? undefined,
    sort: params.get('sort') ?? 'displayName',
    page,
    pageSize: PAGE_SIZE,
  };

  const schoolId = school.data?.schoolId;
  const list = useLocations(schoolId, filters);

  const canSeeConfig = can('location:view_config');
  const facets = list.data?.facets;
  const hasFilters = Boolean(filters.q || filters.status || filters.type || filters.city);
  const totalAll = facets ? Object.entries(facets.statuses).reduce((n, [s, c]) => (s === 'ARCHIVED' ? n : n + c), 0) : 0;
  const everything = facets ? Object.values(facets.statuses).reduce((n, c) => n + c, 0) : 0;

  const header = (
    <PageHeader
      eyebrow="School Setup"
      title="Locations"
      description="Campuses, branches and offices that belong to your school."
      actions={
        schoolId && (
          <Can permission="location:create">
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add Location
            </Button>
          </Can>
        )
      }
    />
  );

  if (school.isLoading) {
    return (
      <>
        {header}
        <Card className="p-0">
          <ListSkeleton />
        </Card>
      </>
    );
  }
  if (school.isError) return <ErrorState error={school.error} onRetry={() => void school.refetch()} retrying={school.isFetching} />;

  if (!school.data) {
    return (
      <>
        {header}
        <Card>
          <EmptyState
            illustration={<EmptyMap className="w-52" />}
            title="Start with your school profile"
            description="Locations belong to a school. Create the school profile first, then add your campuses."
            action={
              <Can permission="school:edit" fallback={<p className="text-sm text-muted">Your School Admin is still setting things up.</p>}>
                <Button asChild>
                  <Link to="/school-setup/profile">Create School Profile</Link>
                </Button>
              </Can>
            }
          />
        </Card>
      </>
    );
  }

  const statusTabs: { value: LocationStatus | undefined; label: string; count: number }[] = [
    { value: undefined, label: 'All', count: totalAll },
    ...LOCATION_STATUSES.map((s) => ({ value: s, label: LOCATION_STATUS_LABELS[s], count: facets?.statuses[s] ?? 0 })),
  ];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = list.data?.items ?? [];
  const primaryName = items.find((l) => l.isPrimary)?.displayName;
  const showEmpty = list.isSuccess && everything === 0 && !hasFilters;

  return (
    <>
      {header}

      {!canSeeConfig && (
        <Alert tone="info" className="mb-5" title="Limited, read-only view">
          You can see active locations and their basic details. Only School Admins can make changes.
        </Alert>
      )}

      <Card className="overflow-hidden p-0">
        {!showEmpty && (
          <div className="space-y-4 border-b border-line p-4 sm:p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, code or city" aria-label="Search locations" className="pl-10" />
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Combobox
                  aria-label="Filter by type"
                  value={filters.type ?? ''}
                  onChange={(v) => setParam({ type: v })}
                  options={[{ value: '', label: 'All types' }, ...LOCATION_TYPES.map((t) => ({ value: t, label: LOCATION_TYPE_LABELS[t] }))]}
                  searchPlaceholder="Search types…"
                  className="sm:w-48"
                />
                {facets && facets.cities.length > 1 && (
                  <Combobox
                    aria-label="Filter by city"
                    value={filters.city ?? ''}
                    onChange={(v) => setParam({ city: v })}
                    options={[{ value: '', label: 'All cities' }, ...facets.cities.map((c) => ({ value: c.city, label: c.city, hint: String(c.count) }))]}
                    searchPlaceholder="Search cities…"
                    className="sm:w-48"
                  />
                )}
              </div>
            </div>

            {canSeeConfig && (
              <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
                {statusTabs.map((t) => {
                  const active = filters.status === t.value;
                  return (
                    <button
                      key={t.label}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setParam({ status: t.value ?? null })}
                      className={cn(
                        'inline-flex min-h-9 items-center gap-2 rounded-pill border px-3.5 text-[13px] font-semibold transition-colors',
                        active ? 'border-brand bg-brand text-white' : 'border-line bg-white text-ink hover:bg-canvas',
                      )}
                    >
                      {t.label}
                      <span className={cn('rounded-pill px-1.5 py-0.5 text-[11px]', active ? 'bg-white/20' : 'bg-ink/6 text-muted')}>{t.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {list.isLoading && <ListSkeleton />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}

        {showEmpty && (
          <EmptyState
            illustration={<EmptyMap className="w-52" />}
            title="No school locations have been added yet."
            description="Let’s put your school on the map. Your first location becomes your Primary Location."
            action={
              <Can permission="location:create" fallback={<p className="text-sm text-muted">Your School Admin will add the first campus soon.</p>}>
                <Button size="lg" onClick={() => setAdding(true)}>
                  <Plus /> Add Primary Location
                </Button>
              </Can>
            }
          />
        )}

        {list.isSuccess && !showEmpty && items.length === 0 && (
          <EmptyState
            illustration={<SearchX className="size-14 text-muted" aria-hidden="true" />}
            title="No locations match"
            description="Try a different search or clear the filters."
            action={
              <Button
                variant="outline"
                onClick={clearAll}
              >
                <X /> Clear Filters
              </Button>
            }
          />
        )}

        {list.isSuccess && items.length > 0 && schoolId && (
          <>
            <LocationTable items={items} schoolId={schoolId} sort={filters.sort ?? 'displayName'} onSort={(sort) => setParam({ sort: sort === 'displayName' ? null : sort })} currentPrimaryName={primaryName} dimmed={list.isPlaceholderData} />
            <div className="flex flex-col items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted sm:flex-row sm:px-5">
              <p aria-live="polite">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} location{total === 1 ? '' : 's'}
              </p>
              {pageCount > 1 && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) }, true)}>
                    <ChevronLeft /> Previous
                  </Button>
                  <span>
                    Page {page} of {pageCount}
                  </span>
                  <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setParam({ page: String(page + 1) }, true)}>
                    Next <ChevronRight />
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </Card>

      {!canSeeConfig && everything > 0 && (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-muted">
          <Info className="size-4" aria-hidden="true" /> Draft, inactive and archived locations are only visible to School Admins.
        </p>
      )}

      {school.data && <AddLocationDrawer open={adding} onOpenChange={setAdding} school={school.data} isFirst={showEmpty} />}
    </>
  );
}
