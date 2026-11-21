import type { ComponentType } from 'react';
import type { HistoryKind } from '@shared';
import { ArrowLeftRight, BookOpen, FilePlus2, GraduationCap, History, Layers, UserRound, UsersRound } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { formatDateOnly, formatRelative } from '@/lib/format';
import { useStudentHistory } from '../api';
import { HISTORY_INTRO } from '../help-copy';

const ICONS: Record<HistoryKind, ComponentType<{ className?: string }>> = {
  STUDENT: UserRound,
  ADMISSION: FilePlus2,
  ENROLLMENT: GraduationCap,
  SECTION: Layers,
  SUBJECT: BookOpen,
  GUARDIAN: UsersRound,
  TRANSFER: ArrowLeftRight,
};

const KIND_LABEL: Record<HistoryKind, string> = {
  STUDENT: 'Student',
  ADMISSION: 'Admission',
  ENROLLMENT: 'Class',
  SECTION: 'Section',
  SUBJECT: 'Subjects',
  GUARDIAN: 'Parents',
  TRANSFER: 'Move',
};

/** One timeline: classes, sections, subjects, parents and edits, newest first. */
export function HistoryTab({ studentId }: { studentId: string }) {
  const q = useStudentHistory(studentId);
  return (
    <div className="space-y-4">
      <TabIntro title="About the history">{HISTORY_INTRO}</TabIntro>
      <Card>
        {q.isLoading ? (
          <div className="space-y-5" role="status" aria-label="Loading history">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-56" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
            ))}
          </div>
        ) : q.isError || !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : q.data.entries.length === 0 ? (
          <EmptyState illustration={<History className="size-12 text-muted" aria-hidden="true" />} title="No history yet" description="Changes will show up here." />
        ) : (
          <ol className="relative space-y-6 before:absolute before:top-2 before:bottom-2 before:left-[17px] before:w-px before:bg-line" aria-label="History">
            {q.data.entries.map((e) => {
              const Icon = ICONS[e.kind] ?? History;
              return (
                <li key={e.entryId} className="relative flex gap-3">
                  <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-full border border-line bg-white text-brand">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-sm font-semibold text-ink">{e.title}</p>
                    {e.detail && <p className="text-[13px] text-ink/80">{e.detail}</p>}
                    <p className="text-[13px] text-muted">
                      {KIND_LABEL[e.kind]} · {formatDateOnly(e.occurredOn)}
                      {e.actorName ? ` · ${e.actorName}` : ''} ·{' '}
                      <time dateTime={e.recordedAt}>recorded {formatRelative(e.recordedAt)}</time>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </div>
  );
}
