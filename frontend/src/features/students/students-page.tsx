import { useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { ENROLLMENT_STATUSES, ENROLLMENT_STATUS_LABELS, STUDENT_STATUSES, STUDENT_STATUS_LABELS, type StudentDirectoryDTO } from '@shared';
import { ChevronLeft, ChevronRight, ListChecks, ListFilter, Plus, Search, SearchX, UserPlus, UsersRound, X } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { TabIntro } from '@/components/sv/help';
import { useListParams } from '@/hooks/use-list-params';
import { cn } from '@/lib/utils';
import { useClassOfferings, useSections } from '../academic/api';
import { useAttention, useStudents, type StudentListParams } from './api';
import { useStudentContext } from './context';
import { STUDENTS_INTRO } from './help-copy';
import { AddStudentDrawer } from './add-student-drawer';
import { placementText, StudentStatusPill } from './student-bits';

const PAGE_SIZE = 20;

function ListSkeleton() {
  return (
    <div className="divide-y divide-line" role="status" aria-label="Loading students">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="hidden h-6 w-24 md:block" />
        </div>
      ))}
    </div>
  );
}

function StudentTable({ items, dimmed }: { items: StudentDirectoryDTO[]; dimmed?: boolean }) {
  return (
    <>
      <div className={cn('hidden overflow-x-auto md:block', dimmed && 'opacity-60 transition-opacity')}>
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">Students</caption>
          <thead className="border-b border-line bg-canvas/70">
            <tr>
              {['Student', 'Admission no.', 'Class', 'Primary parent', 'Status'].map((h) => (
                <th key={h} scope="col" className="px-3 py-3 text-left text-xs font-bold tracking-wide text-muted uppercase">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((s) => (
              <tr key={s.studentId} className="hover:bg-canvas/60">
                <td className="px-3 py-3">
                  <Link to={`/students/${s.studentId}`} className="group flex items-center gap-3 rounded-lg">
                    <Avatar name={s.fullName} />
                    <span className="block max-w-[220px] truncate font-semibold text-ink group-hover:text-brand group-hover:underline">{s.displayName}</span>
                  </Link>
                </td>
                <td className="px-3 py-3 font-mono text-[13px] font-semibold tracking-wide">{s.admissionNumber ?? '—'}</td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {s.classSection ? placementText(s.classSection, s.rollNumber) : <span className="text-muted">No class yet</span>}
                  {s.classSection && !s.classSection.sectionId && <span className="ml-2 text-xs text-warning">No section</span>}
                </td>
                <td className="px-3 py-3">{s.primaryGuardianName ?? <span className="text-muted">None yet</span>}</td>
                <td className="px-3 py-3">
                  <StudentStatusPill status={s.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: stacked cards */}
      <ul className={cn('divide-y divide-line md:hidden', dimmed && 'opacity-60')} aria-label="Students">
        {items.map((s) => (
          <li key={s.studentId} className="flex items-start gap-3 p-4">
            <Avatar name={s.fullName} />
            <div className="min-w-0 flex-1">
              <Link to={`/students/${s.studentId}`} className="block truncate font-semibold text-ink hover:text-brand">
                {s.displayName}
              </Link>
              <p className="mt-0.5 text-xs text-muted">
                <span className="font-mono font-semibold">{s.admissionNumber ?? 'No admission no.'}</span> · {placementText(s.classSection, s.rollNumber)}
              </p>
              <p className="mt-0.5 text-xs text-muted">{s.primaryGuardianName ? `Parent: ${s.primaryGuardianName}` : 'No parent yet'}</p>
              <div className="mt-2">
                <StudentStatusPill status={s.status} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Things to fix come before the big numbers. */
function SummaryStrip({ academicSessionId, locationId }: { academicSessionId?: string; locationId?: string }) {
  const q = useAttention({ academicSessionId, locationId }, Boolean(academicSessionId));
  if (!q.data) return null;
  const { needsAttention, activeStudents, newThisYear, portalActivationPercent, withdrawalsThisYear } = q.data.counts;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Student summary">
      <Link
        to="/students/attention"
        className={cn(
          'col-span-2 flex items-center gap-3 rounded-card border p-3.5 transition-colors lg:col-span-1',
          needsAttention > 0 ? 'border-warning/40 bg-warning-soft hover:bg-warning-soft/70' : 'border-line bg-white hover:bg-canvas',
        )}
      >
        <ListChecks className={cn('size-6', needsAttention > 0 ? 'text-warning' : 'text-success')} aria-hidden="true" />
        <span>
          <span className="block text-2xl leading-none font-extrabold">{needsAttention}</span>
          <span className="text-sm text-muted">{needsAttention === 0 ? 'Nothing needs attention' : 'Need attention. See what to fix'}</span>
        </span>
      </Link>
      <div className="rounded-card border border-line bg-white p-3.5">
        <span className="block text-2xl leading-none font-extrabold">{activeStudents}</span>
        <span className="text-sm text-muted">Active students</span>
      </div>
      <div className="rounded-card border border-line bg-white p-3.5">
        <span className="block text-2xl leading-none font-extrabold">{newThisYear}</span>
        <span className="text-sm text-muted">New this year</span>
      </div>
      <div className="rounded-card border border-line bg-white p-3.5">
        <span className="block text-2xl leading-none font-extrabold">{portalActivationPercent === null ? '—' : `${portalActivationPercent}%`}</span>
        <span className="text-sm text-muted">Have a parent login</span>
      </div>
      <Link to="/students/exits" className="rounded-card border border-line bg-white p-3.5 hover:bg-canvas">
        <span className="block text-2xl leading-none font-extrabold">{withdrawalsThisYear}</span>
        <span className="text-sm text-muted">Leaving or left this year</span>
      </Link>
    </div>
  );
}

/** `/students`: every student of the chosen year and campus. Filters live in the URL, so a filtered list can be shared. */
export function StudentsPage() {
  const navigate = useNavigate();
  const adding = Boolean(useMatch('/students/new'));
  const ctx = useStudentContext();
  const { params, setParam, page, search, setSearch, clearAll } = useListParams();
  const [moreOpen, setMoreOpen] = useState(false);

  const locationParam = params.get('locationId') ?? '';
  const effectiveLocation = locationParam === 'ALL' ? undefined : locationParam || ctx.locationId;
  const classOfferingId = params.get('classOfferingId') ?? undefined;
  const classes = useClassOfferings(ctx.sessionId, effectiveLocation);
  const sections = useSections(classOfferingId);

  const filters: StudentListParams = {
    q: params.get('q') ?? undefined,
    academicSessionId: ctx.sessionId,
    locationId: effectiveLocation,
    classOfferingId,
    sectionId: classOfferingId ? (params.get('sectionId') ?? undefined) : undefined,
    status: params.get('status') ?? undefined,
    enrollmentStatus: params.get('enrollmentStatus') ?? undefined,
    missingGuardian: params.get('missingGuardian') === 'true',
    missingSection: params.get('missingSection') === 'true',
    page,
    pageSize: PAGE_SIZE,
  };
  const list = useStudents(filters, Boolean(ctx.sessionId));

  const hasFilters = Boolean(filters.q || classOfferingId || filters.status || filters.enrollmentStatus || filters.missingGuardian || filters.missingSection);
  const moreCount = [locationParam, filters.enrollmentStatus, filters.missingGuardian || undefined, filters.missingSection || undefined].filter(Boolean).length;
  const showMore = moreOpen || moreCount > 0;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        eyebrow="Students"
        title="Students"
        description="Everyone studying at your school, with their class, section and parents."
        actions={
          <Can permission="student:manage">
            <Button onClick={() => navigate('/students/new')}>
              <UserPlus /> Add Student
            </Button>
          </Can>
        }
      />
      <TabIntro title="About students" className="mb-4">
        {STUDENTS_INTRO}
      </TabIntro>
      <SummaryStrip academicSessionId={ctx.sessionId} locationId={effectiveLocation} />

      <Card className="p-0">
        <div className="space-y-3 border-b border-line p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="relative sm:col-span-2 lg:col-span-1">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, admission no., roll or parent"
                aria-label="Search students"
                className="pl-10"
              />
            </div>
            <Combobox
              aria-label="Class"
              value={classOfferingId ?? ''}
              onChange={(v) => setParam({ classOfferingId: v, sectionId: null })}
              options={[{ value: '', label: 'All classes' }, ...(classes.data ?? []).map((c) => ({ value: c.classOfferingId, label: c.displayName, hint: c.displayCode }))]}
              searchPlaceholder="Search classes…"
            />
            <Combobox
              aria-label="Section"
              value={filters.sectionId ?? ''}
              disabled={!classOfferingId}
              onChange={(v) => setParam({ sectionId: v })}
              options={[{ value: '', label: classOfferingId ? 'All sections' : 'Pick a class first' }, ...(sections.data ?? []).map((s) => ({ value: s.sectionOfferingId, label: s.displayName, hint: s.sectionCode }))]}
              searchPlaceholder="Search sections…"
            />
            <Combobox
              aria-label="Status"
              value={filters.status ?? ''}
              onChange={(v) => setParam({ status: v })}
              options={[{ value: '', label: 'Current students' }, ...STUDENT_STATUSES.map((s) => ({ value: s, label: STUDENT_STATUS_LABELS[s] }))]}
              searchPlaceholder="Search statuses…"
            />
            <Button
              variant="outline"
              aria-expanded={showMore}
              aria-controls="more-filters"
              onClick={() => setMoreOpen((v) => !v)}
              disabled={moreCount > 0}
              title={moreCount > 0 ? 'Clear these filters to hide them' : undefined}
            >
              <ListFilter /> More Filters{moreCount > 0 ? ` (${moreCount})` : ''}
            </Button>
          </div>
          {showMore && (
            <div id="more-filters" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Combobox
                aria-label="Location"
                value={locationParam}
                onChange={(v) => setParam({ locationId: v, classOfferingId: null, sectionId: null })}
                options={[{ value: '', label: 'This campus' }, { value: 'ALL', label: 'All campuses' }, ...ctx.locations.map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))]}
                searchPlaceholder="Search campuses…"
              />
              <Combobox
                aria-label="Class status"
                value={filters.enrollmentStatus ?? ''}
                onChange={(v) => setParam({ enrollmentStatus: v })}
                options={[{ value: '', label: 'Any class status' }, ...ENROLLMENT_STATUSES.map((s) => ({ value: s, label: ENROLLMENT_STATUS_LABELS[s] }))]}
                searchPlaceholder="Search…"
              />
              <Combobox
                aria-label="Parent"
                value={filters.missingGuardian ? 'missing' : ''}
                onChange={(v) => setParam({ missingGuardian: v === 'missing' ? 'true' : null })}
                options={[{ value: '', label: 'Any parent status' }, { value: 'missing', label: 'No parent linked' }]}
                searchPlaceholder="Search…"
              />
              <Combobox
                aria-label="Section status"
                value={filters.missingSection ? 'missing' : ''}
                onChange={(v) => setParam({ missingSection: v === 'missing' ? 'true' : null })}
                options={[{ value: '', label: 'Any section status' }, { value: 'missing', label: 'No section yet' }]}
                searchPlaceholder="Search…"
              />
            </div>
          )}
        </div>

        {list.isLoading || ctx.loading ? (
          <ListSkeleton />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : total === 0 && !hasFilters ? (
          <EmptyState
            illustration={<UsersRound className="size-14 text-brand" aria-hidden="true" />}
            title="No students yet"
            description="Add your first student. You only need their name, class and a parent’s phone number."
            action={
              <Can permission="student:manage">
                <Button onClick={() => navigate('/students/new')}>
                  <Plus /> Add Your First Student
                </Button>
              </Can>
            }
          />
        ) : total === 0 ? (
          <EmptyState
            illustration={<SearchX className="size-14 text-muted" aria-hidden="true" />}
            title="No student matches these filters"
            description="Try a different search, or clear the filters."
            action={
              <Button variant="outline" onClick={clearAll}>
                <X /> Clear Filters
              </Button>
            }
          />
        ) : (
          <>
            <StudentTable items={list.data!.items} dimmed={list.isFetching} />
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <p aria-live="polite">
                {total} {total === 1 ? 'student' : 'students'}
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

      <AddStudentDrawer open={adding} onOpenChange={(open) => !open && navigate('/students')} />
    </>
  );
}
