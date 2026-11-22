import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';
import { ROLE_LABELS, STUDENT_DOCUMENT_TYPE_LABELS, type StudentDocumentDTO } from '@shared';
import { ArrowRight, BookOpen, Download, FileText, GraduationCap, Hash, Inbox, SearchX, ShieldOff, Sparkles, UserRound, UsersRound } from 'lucide-react';
import { motion } from 'motion/react';
import { CampusScene } from '@/components/illustrations/campus-scene';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { firstName, greetingFor } from '@/lib/utils';
import { formatSize } from '@/components/sv/documents';
import { useDocumentDownload } from '../students/tabs/documents-tab';
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

/** A short card for the selected child on Home: name, class, roll number. The full details are on "My Child". */
function ChildSnapshot({ studentId }: { studentId: string }) {
  const q = useParentChild(studentId);
  if (q.isLoading) return <Skeleton className="h-24 rounded-card" role="status" aria-label="Loading" />;
  if (q.error instanceof ApiError && q.error.status === 404) return <ChildUnavailable studentId={studentId} />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const c = q.data;
  return (
    <section className="rounded-card border border-line bg-white p-4 shadow-card" aria-label="Selected child">
      <h3 className="text-lg font-bold text-ink">{c.displayName || c.fullName}</h3>
      <p className="mt-0.5 text-[13px] text-muted">
        Admission number <span className="font-mono font-semibold text-ink">{c.admissionNumber ?? '—'}</span>
        {c.campusName ? ` · ${c.campusName}` : ''}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
            <GraduationCap className="size-4" aria-hidden="true" /> Class and section
          </dt>
          <dd className="font-bold text-ink">{c.classSection?.label ?? 'Not placed yet'}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
            <Hash className="size-4" aria-hidden="true" /> Roll number
          </dt>
          <dd className="font-bold text-ink">{c.rollNumber ?? '—'}</dd>
        </div>
      </dl>
    </section>
  );
}

interface ParentLink {
  title: string;
  text: string;
  Icon: ComponentType<{ className?: string }>;
  tint: string;
  to: (child: string | undefined) => string;
}

/** Same card style as the staff Home page. */
const PARENT_LINKS: ParentLink[] = [
  {
    title: 'My child',
    text: 'See class, roll number, subjects and who the primary parent is.',
    Icon: UserRound,
    tint: 'bg-brand-soft text-brand',
    to: (c) => (c ? `/parent/children/${c}` : '/parent'),
  },
  {
    title: 'Documents',
    text: 'Download papers the school has shared with you.',
    Icon: FileText,
    tint: 'bg-sun-soft text-warning',
    to: (c) => (c ? `/parent/documents?child=${c}` : '/parent/documents'),
  },
  {
    title: 'Ask for a change',
    text: 'Tell the school if a detail is wrong. They will check it and reply.',
    Icon: Inbox,
    tint: 'bg-coral-soft text-coral',
    to: () => '/parent/requests',
  },
];

/** `/parent`: a hero and quick links like the other portals, plus the child switcher and a short card for the selected child. */
export function ParentHomePage() {
  const session = useSession();
  const { query, children, selectedId, select } = useChildSelection();
  const noChildren = children.length === 0 && !selectedId;
  return (
    <div className="space-y-6">
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 160, damping: 20 }}
        className="relative overflow-hidden rounded-[20px] bg-navy px-5 py-5 text-white shadow-pop sm:px-10 sm:py-8"
      >
        <div className="pointer-events-none absolute -top-20 right-1/3 size-64 rounded-full bg-brand opacity-60 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 size-64 rounded-full bg-lavender opacity-30 blur-3xl" />
        <div className="relative grid items-center gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <Badge tone="sun" className="mb-3">
              <Sparkles /> {ROLE_LABELS[session.user.role]} Workspace
            </Badge>
            <h1 className="text-[28px] leading-tight font-extrabold sm:text-[34px]">
              {greetingFor()}, {firstName(session.user.fullName)} <span className="inline-block animate-wiggle origin-bottom">👋</span>
            </h1>
            <p className="mt-3 max-w-lg text-[15px] text-navy-text">
              Welcome to <strong className="text-white">{session.tenant.name}</strong> on SchoolVerse.
            </p>
          </div>
          <CampusScene className="mx-auto hidden max-w-[340px] lg:-my-5 lg:block" />
        </div>
      </motion.section>

      {query.isLoading ? (
        <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : noChildren ? (
        <NoChildren />
      ) : (
        <section aria-labelledby="parent-children">
          <h2 id="parent-children" className="mb-3 text-lg font-bold text-ink">
            {children.length > 1 ? 'Your children' : 'Your child'}
          </h2>
          <ChildSwitcher kids={children} selectedId={selectedId} onSelect={select} />
          {selectedId && <ChildSnapshot studentId={selectedId} />}
        </section>
      )}

      <section aria-labelledby="parent-actions">
        <h2 id="parent-actions" className="text-lg font-bold text-ink">
          What you can do
        </h2>
        <p className="mt-0.5 text-sm text-muted">Jump straight to the part you need.</p>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {PARENT_LINKS.map(({ title, text, Icon, tint, to }) => (
            <li key={title}>
              <Link
                to={to(selectedId)}
                className="group flex h-full min-h-16 items-start gap-3.5 rounded-card border border-line bg-white px-5 py-4 shadow-card outline-none transition hover:-translate-y-0.5 hover:border-brand/40 focus-visible:ring-4 focus-visible:ring-brand/20"
              >
                <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${tint}`}>
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{title}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{text}</span>
                </span>
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** `/parent/children/:studentId`: one child, with every shared document. Another family's child is "Not found". */
export function ParentChildPage() {
  const { query, children, selectedId, select } = useChildSelection();
  if (query.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  return (
    <div className="max-w-3xl">
      <ChildSwitcher kids={children} selectedId={selectedId} onSelect={select} />
      {selectedId ? <ChildView studentId={selectedId} showAllDocuments /> : <NoChildren />}
    </div>
  );
}

/** `/parent/documents`: documents the school has shared for the selected child. */
export function ParentDocumentsPage() {
  const { query, children, selectedId, select } = useChildSelection();
  const child = children.find((c) => c.studentId === selectedId);
  if (query.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />;
  if (!selectedId) return <NoChildren />;
  return (
    <div className="max-w-3xl">
      <ChildSwitcher kids={children} selectedId={selectedId} onSelect={select} />
      <h1 className="mb-1 text-[22px] font-extrabold">Documents</h1>
      <p className="mb-3 text-sm text-muted">{child ? `Papers the school has shared for ${child.displayName || child.fullName}.` : 'Papers the school has shared.'} Each link works for one minute.</p>
      <div className="rounded-card border border-line bg-white px-4 py-1 shadow-card">
        <DocumentList studentId={selectedId} />
      </div>
    </div>
  );
}
