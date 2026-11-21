import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { STUDENT_DOCUMENT_TYPE_LABELS, type StudentDocumentDTO } from '@shared';
import { BookOpen, Download, FileText, GraduationCap, Hash, SearchX, ShieldOff, UserRound, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { firstName, greetingFor } from '@/lib/utils';
import { formatSize, useDocumentDownload } from '../students/tabs/documents-tab';
import { useParentChild, useParentDocuments, wasSeen } from './api';
import { ChildSwitcher, useChildSelection } from './parent-layout';

function Tile({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-white p-4 shadow-card" aria-label={label}>
      <p className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-muted">
        {icon} {label}
      </p>
      <div className="text-lg font-bold text-ink">{children}</div>
    </section>
  );
}

function NoChildren() {
  return (
    <EmptyState
      illustration={<UsersRound className="size-14 text-muted" aria-hidden="true" />}
      title="No children are linked to this login"
      description="Please contact the school. They can link your child to your login."
    />
  );
}

/** A child the server will not show: removed during this visit ("no longer have access") or never this parent's ("Not found"). */
function ChildUnavailable({ studentId }: { studentId: string }) {
  const removed = wasSeen(studentId);
  return (
    <EmptyState
      illustration={removed ? <ShieldOff className="size-14 text-muted" aria-hidden="true" /> : <SearchX className="size-14 text-muted" aria-hidden="true" />}
      title={removed ? 'You no longer have access to this child' : 'Not found'}
      description={removed ? 'The school has changed who can see this child. Please contact the school if this is a mistake.' : 'We could not find this page. The link may be wrong, or it may not be one you can open.'}
      action={
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/parent">Go To Home</Link>
        </Button>
      }
    />
  );
}

function DocumentList({ studentId, limit }: { studentId: string; limit?: number }) {
  const q = useParentDocuments(studentId);
  const { download, downloading } = useDocumentDownload();
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.error instanceof ApiError && q.error.status === 404) return <ChildUnavailable studentId={studentId} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const items = (q.data ?? []).slice(0, limit);
  if (items.length === 0) return <p className="text-sm text-muted">The school has not shared any documents yet.</p>;
  return (
    <ul className="divide-y divide-line" aria-label="Shared documents">
      {items.map((d: StudentDocumentDTO) => (
        <li key={d.documentId} className="flex items-center gap-3 py-3">
          <FileText className="size-5 shrink-0 text-brand" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{d.displayName}</p>
            <p className="text-xs text-muted">
              {STUDENT_DOCUMENT_TYPE_LABELS[d.documentType]} · {formatSize(d.sizeBytes)} · {formatDateOnly(d.uploadedAt.slice(0, 10))}
            </p>
          </div>
          <Button size="sm" variant="outline" className="min-h-11" onClick={() => void download(d)} loading={downloading === d.documentId} loadingText="Opening…" aria-label={`Download ${d.displayName}`}>
            <Download /> Download
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The cards for one child: class and section, roll number, subjects, primary parent, shared documents. */
function ChildView({ studentId, showAllDocuments }: { studentId: string; showAllDocuments?: boolean }) {
  const q = useParentChild(studentId);
  if (q.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  if (q.error instanceof ApiError && q.error.status === 404) return <ChildUnavailable studentId={studentId} />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const c = q.data;
  return (
    <div className="space-y-3">
      <h1 className="text-[22px] font-extrabold">{c.displayName || c.fullName}</h1>
      <p className="-mt-2 text-sm text-muted">
        Admission number <span className="font-mono font-semibold text-ink">{c.admissionNumber ?? '—'}</span>
        {c.campusName ? ` · ${c.campusName}` : ''}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Tile icon={<GraduationCap className="size-4" aria-hidden="true" />} label="Class and section">
          {c.classSection?.label ?? 'Not placed yet'}
        </Tile>
        <Tile icon={<Hash className="size-4" aria-hidden="true" />} label="Roll number">
          {c.rollNumber ?? '—'}
        </Tile>
      </div>
      <Tile icon={<BookOpen className="size-4" aria-hidden="true" />} label="Subjects">
        {c.subjects.length === 0 ? (
          <span className="text-sm font-normal text-muted">No subjects yet.</span>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-2">
            {c.subjects.map((s) => (
              <li key={s.subjectOfferingId} className="rounded-pill bg-brand-soft px-3 py-1 text-sm font-semibold text-brand">
                {s.subjectName}
              </li>
            ))}
          </ul>
        )}
      </Tile>
      <Tile icon={<UserRound className="size-4" aria-hidden="true" />} label="Primary parent">
        {c.primaryGuardianName ?? '—'}
      </Tile>
      <section className="rounded-card border border-line bg-white p-4 shadow-card" aria-label="Documents from the school">
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[13px] font-semibold text-muted">
            <FileText className="size-4" aria-hidden="true" /> Documents from the school
          </p>
          {!showAllDocuments && (
            <Link to={`/parent/documents?child=${studentId}`} className="text-sm font-semibold text-brand hover:underline">
              See all
            </Link>
          )}
        </div>
        <DocumentList studentId={studentId} limit={showAllDocuments ? undefined : 3} />
      </section>
    </div>
  );
}

/** `/parent`: the child switcher and the cards for the selected child. */
export function ParentHomePage() {
  const session = useSession();
  const { query, children, selectedId, select } = useChildSelection();
  if (query.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  return (
    <>
      <p className="mb-3 text-sm text-muted">
        {greetingFor()}, {firstName(session.user.fullName)}.
      </p>
      {children.length === 0 && !selectedId ? (
        <NoChildren />
      ) : (
        <>
          <ChildSwitcher kids={children} selectedId={selectedId} onSelect={select} />
          {selectedId && <ChildView studentId={selectedId} />}
        </>
      )}
    </>
  );
}

/** `/parent/children/:studentId`: one child, with every shared document. Another family's child is "Not found". */
export function ParentChildPage() {
  const { query, children, selectedId, select } = useChildSelection();
  if (query.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  return (
    <>
      <ChildSwitcher kids={children} selectedId={selectedId} onSelect={select} />
      {selectedId ? <ChildView studentId={selectedId} showAllDocuments /> : <NoChildren />}
    </>
  );
}

/** `/parent/documents`: documents the school has shared for the selected child. */
export function ParentDocumentsPage() {
  const { query, children, selectedId, select } = useChildSelection();
  const child = children.find((c) => c.studentId === selectedId);
  if (query.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />;
  if (!selectedId) return <NoChildren />;
  return (
    <>
      <ChildSwitcher kids={children} selectedId={selectedId} onSelect={select} />
      <h1 className="mb-1 text-[22px] font-extrabold">Documents</h1>
      <p className="mb-3 text-sm text-muted">{child ? `Papers the school has shared for ${child.displayName || child.fullName}.` : 'Papers the school has shared.'} Each link works for one minute.</p>
      <div className="rounded-card border border-line bg-white px-4 py-1 shadow-card">
        <DocumentList studentId={selectedId} />
      </div>
    </>
  );
}
