import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  EMPLOYEE_CATEGORIES,
  EMPLOYEE_CATEGORY_LABELS,
  EMPLOYEE_STATUSES,
  EMPLOYEE_STATUS_LABELS,
  type EmployeeDirectoryDTO,
} from '@shared';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Search,
  SearchX,
  UsersRound,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar } from '@/components/ui/avatar';
import { Can } from '@/components/sv/can';
import { EmployeeStatusPill } from '@/components/sv/employee-status';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';
import { useActiveLocations } from '../academic/api';
import { AddEmployeeDrawer } from './add-employee-drawer';
import { useDepartments, useDesignations, useEmployees, type EmployeeListParams } from './api';
import { ExportDialog } from './export-dialog';

const PAGE_SIZE = 20;

function ListSkeleton() {
  return (
    <div className="divide-y divide-line" role="status" aria-label="Loading staff">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="hidden h-6 w-24 md:block" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}

function PeopleTable({ items, dimmed }: { items: EmployeeDirectoryDTO[]; dimmed?: boolean }) {
  return (
    <>
      <div
        className={cn('hidden overflow-x-auto md:block', dimmed && 'opacity-60 transition-opacity')}
      >
        <table className="w-full min-w-[820px] text-sm">
          <caption className="sr-only">Faculty and staff</caption>
          <thead className="border-b border-line bg-canvas/70">
            <tr>
              {['Name', 'Code', 'Category', 'Department', 'Designation', 'Location', 'Status'].map(
                (h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-3 text-left text-xs font-bold tracking-wide text-muted uppercase"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((e) => (
              <tr key={e.employeeId} className="hover:bg-canvas/60">
                <td className="px-3 py-3">
                  <Link
                    to={`/people/${e.employeeId}`}
                    className="group flex items-center gap-3 rounded-lg"
                  >
                    <Avatar name={e.fullName} />
                    <span className="min-w-0">
                      <span className="block max-w-[210px] truncate font-semibold text-ink group-hover:text-brand group-hover:underline">
                        {e.displayName}
                      </span>
                      {e.displayName !== e.fullName && (
                        <span className="block max-w-[210px] truncate text-xs text-muted">
                          {e.fullName}
                        </span>
                      )}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-3 font-mono text-[13px] font-semibold tracking-wider">
                  {e.employeeCode}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {EMPLOYEE_CATEGORY_LABELS[e.employeeCategory]}
                </td>
                <td className="px-3 py-3">{e.department.name}</td>
                <td className="px-3 py-3">{e.designation.name}</td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {e.primaryLocation ? e.primaryLocation.displayName : '—'}
                </td>
                <td className="px-3 py-3">
                  <EmployeeStatusPill status={e.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: stacked cards */}
      <ul
        className={cn('divide-y divide-line md:hidden', dimmed && 'opacity-60')}
        aria-label="Faculty and staff"
      >
        {items.map((e) => (
          <li key={e.employeeId} className="flex items-start gap-3 p-4">
            <Avatar name={e.fullName} />
            <div className="min-w-0 flex-1">
              <Link
                to={`/people/${e.employeeId}`}
                className="block truncate font-semibold text-ink hover:text-brand"
              >
                {e.displayName}
              </Link>
              <p className="mt-0.5 text-xs text-muted">
                <span className="font-mono font-semibold">{e.employeeCode}</span> ·{' '}
                {e.designation.name} · {e.department.name}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <EmployeeStatusPill status={e.status} />
                {e.primaryLocation && (
                  <span className="text-xs text-muted">{e.primaryLocation.displayName}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** `/people`: the directory for School Admins. Filters live in the URL, so a filtered view can be shared or bookmarked. */
export function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const departments = useDepartments();
  const designations = useDesignations();
  const locations = useActiveLocations();

  const filters: EmployeeListParams = {
    q: params.get('q') ?? undefined,
    category: params.get('category') ?? undefined,
    departmentId: params.get('departmentId') ?? undefined,
    designationId: params.get('designationId') ?? undefined,
    locationId: params.get('locationId') ?? undefined,
    status: params.get('status') ?? undefined,
    page: Number(params.get('page')) > 0 ? Number(params.get('page')) : 1,
    pageSize: PAGE_SIZE,
  };

  const setParam = (updates: Record<string, string | null>, keepPage = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        if (!keepPage) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };

  const [search, setSearch] = useState(filters.q ?? '');
  const debounced = useDebouncedValue(search, 300);
  useEffect(() => {
    if ((debounced.trim() || undefined) !== (params.get('q') ?? undefined))
      setParam({ q: debounced.trim() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const list = useEmployees(filters);
  const hasFilters = Boolean(
    filters.q ||
    filters.category ||
    filters.departmentId ||
    filters.designationId ||
    filters.locationId ||
    filters.status,
  );
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clear = () => {
    setSearch('');
    setParams({}, { replace: true });
  };

  const header = (
    <PageHeader
      eyebrow="People"
      title="Faculty & Staff"
      description="Everyone who works at your school: where they are placed, what they teach or look after, and whether they have a login."
      actions={
        <>
          <Can permission="employee:export">
            <Button variant="outline" onClick={() => setExporting(true)}>
              <Download /> Export
            </Button>
          </Can>
          <Can permission="employee:manage">
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add employee
            </Button>
          </Can>
        </>
      }
    />
  );

  return (
    <>
      {header}
      <Card className="p-0">
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="relative sm:col-span-2">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or code"
              aria-label="Search by name or employee code"
              className="pl-10"
            />
          </div>
          <Select
            aria-label="Category"
            value={filters.category ?? ''}
            onChange={(e) => setParam({ category: e.target.value })}
          >
            <option value="">All categories</option>
            {EMPLOYEE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {EMPLOYEE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Department"
            value={filters.departmentId ?? ''}
            onChange={(e) => setParam({ departmentId: e.target.value })}
          >
            <option value="">All departments</option>
            {(departments.data ?? []).map((d) => (
              <option key={d.departmentId} value={d.departmentId}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Designation"
            value={filters.designationId ?? ''}
            onChange={(e) => setParam({ designationId: e.target.value })}
          >
            <option value="">All designations</option>
            {(designations.data ?? []).map((d) => (
              <option key={d.designationId} value={d.designationId}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Location"
            value={filters.locationId ?? ''}
            onChange={(e) => setParam({ locationId: e.target.value })}
          >
            <option value="">All locations</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.locationId} value={l.locationId}>
                {l.displayName}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={filters.status ?? ''}
            onChange={(e) => setParam({ status: e.target.value })}
            className="lg:col-start-6"
          >
            <option value="">Current staff</option>
            {EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {EMPLOYEE_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>

        {list.isLoading ? (
          <ListSkeleton />
        ) : list.isError ? (
          <ErrorState
            error={list.error}
            onRetry={() => void list.refetch()}
            retrying={list.isFetching}
          />
        ) : total === 0 && !hasFilters ? (
          <EmptyState
            illustration={<UsersRound className="size-14 text-brand" aria-hidden="true" />}
            title="No staff yet"
            description="Add your first team member. You can place them at a campus, give them classes or responsibilities, and create their login."
            action={
              <Can permission="employee:manage">
                <Button onClick={() => setAdding(true)}>
                  <Plus /> Add your first team member
                </Button>
              </Can>
            }
          />
        ) : total === 0 ? (
          <EmptyState
            illustration={<SearchX className="size-14 text-muted" aria-hidden="true" />}
            title="No one matches these filters"
            description="Try a different search, or clear the filters."
            action={
              <Button variant="outline" onClick={clear}>
                <X /> Clear filters
              </Button>
            }
          />
        ) : (
          <>
            <PeopleTable items={list.data!.items} dimmed={list.isFetching} />
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <p aria-live="polite">
                {total} {total === 1 ? 'person' : 'people'}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filters.page! <= 1}
                  onClick={() => setParam({ page: String(filters.page! - 1) }, true)}
                  aria-label="Previous page"
                >
                  <ChevronLeft />
                </Button>
                <span>
                  Page {filters.page} of {pages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filters.page! >= pages}
                  onClick={() => setParam({ page: String(filters.page! + 1) }, true)}
                  aria-label="Next page"
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <AddEmployeeDrawer open={adding} onOpenChange={setAdding} />
      {exporting && <ExportDialog open={exporting} onOpenChange={setExporting} filters={filters} />}
    </>
  );
}
