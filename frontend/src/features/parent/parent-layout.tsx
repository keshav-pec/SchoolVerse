import { useEffect, useMemo, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { ParentChildDTO } from '@shared';
import { FileText, House, Inbox, LogOut, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoMark } from '@/components/sv/logo';
import { useAuth, useSession } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { rememberChildren, useParentChildren } from './api';

/**
 * Which child the parent is looking at. It lives in the URL (`/parent?child=…`, `/parent/children/:studentId`), so a reload or a
 * shared link keeps it. With nothing in the URL, the first child is selected.
 */
export function useChildSelection() {
  const { studentId } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const q = useParentChildren();
  const children = useMemo(() => q.data?.children ?? [], [q.data]);
  const urlId = studentId ?? params.get('child') ?? undefined;
  const selectedId = urlId ?? children[0]?.studentId;

  useEffect(() => {
    if (children.length) rememberChildren(children.map((c) => c.studentId));
  }, [children]);

  const select = (id: string) => {
    if (location.pathname.startsWith('/parent/children/')) navigate(`/parent/children/${id}`);
    else navigate(`${location.pathname}?child=${id}`);
  };
  return { query: q, children, selectedId, select };
}

/** Names and classes as big buttons: one tap switches child. Hidden when there is only one child. */
export function ChildSwitcher({ kids, selectedId, onSelect }: { kids: ParentChildDTO[]; selectedId: string | undefined; onSelect: (id: string) => void }) {
  if (kids.length < 2) return null;
  return (
    <div role="tablist" aria-label="Choose a child" className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1">
      {kids.map((c) => {
        const active = c.studentId === selectedId;
        return (
          <button
            key={c.studentId}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(c.studentId)}
            className={cn('min-h-12 shrink-0 rounded-xl border px-4 py-2 text-left', active ? 'border-brand bg-brand text-white' : 'border-line bg-white text-ink hover:border-brand/40')}
          >
            <span className="block text-sm font-bold">{c.displayName || c.fullName}</span>
            <span className={cn('block text-xs', active ? 'text-white/80' : 'text-muted')}>{c.classSection?.label ?? 'No class yet'}</span>
          </button>
        );
      })}
    </div>
  );
}

interface Tab {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  to: (child: string | undefined) => string;
  match: (path: string) => boolean;
}

const TABS: Tab[] = [
  { label: 'Home', Icon: House, to: (c) => (c ? `/parent?child=${c}` : '/parent'), match: (p) => p === '/parent' },
  { label: 'My Child', Icon: UserRound, to: (c) => (c ? `/parent/children/${c}` : '/parent'), match: (p) => p.startsWith('/parent/children') },
  { label: 'Documents', Icon: FileText, to: (c) => (c ? `/parent/documents?child=${c}` : '/parent/documents'), match: (p) => p.startsWith('/parent/documents') },
  { label: 'Requests', Icon: Inbox, to: () => '/parent/requests', match: (p) => p.startsWith('/parent/requests') },
];

/** The parent portal's own simple layout: no admin sidebar, large touch targets, works from 360px wide. */
export function ParentLayout() {
  const session = useSession();
  const { logout } = useAuth();
  const location = useLocation();
  const { selectedId } = useChildSelection();

  const signOut = async () => {
    await logout();
    window.location.replace('/login');
  };

  return (
    <div className="min-h-dvh bg-canvas pb-20 sm:pb-6">
      <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <LogoMark className="size-8" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold">{session.tenant.name}</p>
            <p className="truncate text-xs text-muted">Parent portal · {session.user.fullName}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void signOut()} className="min-h-11">
            <LogOut /> Sign Out
          </Button>
        </div>
        <nav aria-label="Parent portal" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white sm:static sm:border-t-0">
          <ul className="mx-auto grid max-w-3xl grid-cols-4 sm:flex sm:gap-1 sm:px-4">
            {TABS.map((t) => {
              const active = t.match(location.pathname);
              return (
                <li key={t.label}>
                  <NavLink
                    to={t.to(selectedId)}
                    aria-current={active ? 'page' : undefined}
                    className={cn('flex min-h-14 flex-col items-center justify-center gap-0.5 px-3 text-xs font-semibold sm:min-h-11 sm:flex-row sm:gap-2 sm:text-sm', active ? 'text-brand sm:border-b-2 sm:border-brand' : 'text-muted hover:text-ink')}
                  >
                    <t.Icon className="size-5 sm:size-4" />
                    {t.label}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
