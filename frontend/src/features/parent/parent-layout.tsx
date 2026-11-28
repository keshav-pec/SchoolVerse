import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ROLE_LABELS, type ParentChildDTO } from '@shared';
import { CalendarDays, FileText, House, Inbox, PanelLeftClose, PanelLeftOpen, ReceiptText, UserRound } from 'lucide-react';
import { CollapsedTip, UserMenu } from '@/layouts/app-shell';
import { SchoolLogo } from '@/components/sv/school-logo';
import { useSession } from '@/lib/auth';
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
  { label: 'Timetable', Icon: CalendarDays, to: (c) => (c ? `/parent/timetable?child=${c}` : '/parent/timetable'), match: (p) => p.startsWith('/parent/timetable') },
  { label: 'Documents', Icon: FileText, to: (c) => (c ? `/parent/documents?child=${c}` : '/parent/documents'), match: (p) => p.startsWith('/parent/documents') },
  { label: 'Fees', Icon: ReceiptText, to: () => '/parent/fees', match: (p) => p.startsWith('/parent/fees') },
  { label: 'Requests', Icon: Inbox, to: () => '/parent/requests', match: (p) => p.startsWith('/parent/requests') },
];

function crumbFor(pathname: string) {
  return TABS.find((t) => t.match(pathname))?.label ?? 'Home';
}

/**
 * The parent portal's own layout. It follows the staff AppShell: a navy sidebar and a top bar with the breadcrumb and account menu
 * from `md` up. On phones the same links are a bottom bar with large touch targets, and it works from 360px wide.
 */
export function ParentLayout() {
  const session = useSession();
  const location = useLocation();
  const { selectedId, children: kids } = useChildSelection();
  // Fees only show up for a parent who may see fees for at least one child; the API decides the rest.
  const tabs = TABS.filter((t) => t.label !== 'Fees' || kids.some((c) => c.canSeeFees));
  // Same remembered choice as the staff sidebar.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sv.sidebar.collapsed') === '1');
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem('sv.sidebar.collapsed', c ? '0' : '1');
      return !c;
    });

  return (
    <div className={cn('min-h-dvh bg-canvas pb-24 transition-[padding] duration-200 md:pb-0', collapsed ? 'md:pl-[72px]' : 'md:pl-[248px]')}>
      <a href="#main" className="sr-only z-50 rounded-lg bg-white px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>

      {/* Phones: a bar pinned to the bottom. Desktop: the sidebar. It sits outside the header because a blurred parent would trap `fixed`. */}
      <aside
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.06)] md:inset-y-0 md:right-auto md:flex md:flex-col md:border-t-0 md:bg-navy md:pt-5 md:pb-3 md:text-navy-text md:shadow-none md:transition-[width] md:duration-200',
          collapsed ? 'md:w-[72px] md:px-2' : 'md:w-[248px] md:px-3',
        )}
      >
        <CollapsedTip label={`${session.tenant.name} – Home`} active={collapsed}>
        <NavLink
          to="/parent"
          end
          aria-label={`${session.tenant.name} – Home`}
          className={cn(
            'mx-1 hidden items-center gap-2.5 rounded-[10px] border border-[#284469] bg-navy-700 px-3 py-3 transition-colors hover:bg-navy-600 focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none md:flex',
            collapsed && 'md:mx-0 md:justify-center md:px-0',
          )}
        >
          <SchoolLogo schoolName={session.tenant.name} />
          <span className={cn('min-w-0', collapsed && 'md:hidden')}>
            <span className="block truncate text-[13px] font-semibold text-white" title={session.tenant.name}>
              {session.tenant.name}
            </span>
            <span className="block text-[11px] text-navy-muted">{ROLE_LABELS[session.user.role]} workspace</span>
          </span>
        </NavLink>
        </CollapsedTip>
        <nav aria-label="Parent portal" className="md:mt-3 md:flex-1">
          <ul className={cn('mx-auto grid max-w-3xl md:block md:max-w-none md:space-y-0.5', tabs.length >= 6 ? 'grid-cols-6' : tabs.length === 5 ? 'grid-cols-5' : 'grid-cols-4')}>
            {tabs.map((t) => {
              const active = t.match(location.pathname);
              return (
                <li key={t.label}>
                  <CollapsedTip label={t.label} active={collapsed}>
                  <NavLink
                    to={t.to(selectedId)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-3 text-xs font-semibold transition-colors',
                      'md:min-h-11 md:flex-row md:justify-start md:gap-3 md:rounded-lg md:px-3.5 md:text-sm md:font-medium',
                      collapsed && 'md:justify-center md:px-0',
                      active
                        ? 'text-brand md:bg-navy-600 md:text-white md:before:absolute md:before:inset-y-2.5 md:before:left-0 md:before:w-[3px] md:before:rounded-full md:before:bg-[#5084ff]'
                        : 'text-muted hover:text-ink md:text-navy-text md:hover:bg-white/5 md:hover:text-white',
                    )}
                  >
                    <t.Icon className="size-5 shrink-0 md:size-[18px]" />
                    <span className={cn(collapsed && 'md:sr-only')}>{t.label}</span>
                  </NavLink>
                  </CollapsedTip>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <header className="sticky top-0 z-30 flex h-[62px] items-center gap-3 border-b border-line bg-white/85 px-4 backdrop-blur sm:h-[72px] sm:px-8">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="hidden size-10 place-items-center rounded-lg text-ink hover:bg-ink/5 md:grid"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
        </button>
        <SchoolLogo schoolName={session.tenant.name} className="md:hidden" />
        <p className="min-w-0 flex-1 truncate text-sm font-bold md:hidden">{session.tenant.name}</p>
        <nav aria-label="Breadcrumb" className="hidden min-w-0 truncate text-sm text-muted md:block">
          {session.tenant.name}
          <span className="mx-2" aria-hidden="true">
            /
          </span>
          <span className="font-semibold text-ink" aria-current="page">
            {crumbFor(location.pathname)}
          </span>
        </nav>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6">
        <Outlet />
      </main>
    </div>
  );
}
