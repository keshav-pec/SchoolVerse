import { Link } from 'react-router';
import { Search, SearchX, UsersRound, X } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { Pager } from '@/components/sv/pager';
import { useListParams } from '@/hooks/use-list-params';
import { useMyStudents } from './api';
import { MY_STUDENTS_INTRO } from './help-copy';
import { placementText } from './student-bits';

const PAGE_SIZE = 24;

/** `/my-students`: a teacher's own students as cards. Only the fields a teacher may see: no contact, address or birth date. */
export function MyStudentsPage() {
  const { params, setParam, page, search, setSearch, clearAll } = useListParams();
  const q = params.get('q') ?? undefined;
  const list = useMyStudents({ q, page, pageSize: PAGE_SIZE });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader eyebrow="Students" title="My Students" description="The students in the sections you teach." />
      <TabIntro title="About this page" className="mb-4">
        {MY_STUDENTS_INTRO}
      </TabIntro>
      <div className="relative mb-4 max-w-xl">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, admission no. or roll" aria-label="Search my students" className="pl-10" />
      </div>

      {list.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading students">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-card" />
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : total === 0 && !q ? (
        <EmptyState illustration={<UsersRound className="size-14 text-brand" aria-hidden="true" />} title="No students yet" description="You will see students here once you are given a class or section. Ask your School Admin." />
      ) : total === 0 ? (
        <EmptyState
          illustration={<SearchX className="size-14 text-muted" aria-hidden="true" />}
          title="No student matches your search"
          description="Try a different name."
          action={
            <Button variant="outline" onClick={clearAll}>
              <X /> Clear Search
            </Button>
          }
        />
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="My students">
            {list.data!.items.map((s) => (
              <li key={s.studentId}>
                <Link to={`/students/${s.studentId}`} className="flex h-full items-start gap-3 rounded-card border border-line bg-white p-4 shadow-card transition-colors hover:border-brand/40">
                  <Avatar name={s.fullName} className="size-11" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-ink">{s.displayName}</span>
                    <span className="block text-xs text-muted">
                      <span className="font-mono">{s.admissionNumber ?? '—'}</span> · {placementText(s.classSection, s.rollNumber)}
                    </span>
                    {s.subjects.length > 0 && (
                      <span className="mt-2 flex flex-wrap gap-1.5">
                        {s.subjects.map((sub) => (
                          <span key={sub.subjectOfferingId} className="rounded-pill bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">
                            {sub.subjectName}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted">
            <p aria-live="polite">
              {total} {total === 1 ? 'student' : 'students'}
            </p>
            <Pager page={page} pages={pages} onPage={(p) => setParam({ page: String(p) }, true)} />
          </div>
        </>
      )}
    </>
  );
}
