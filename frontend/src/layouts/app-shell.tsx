import { useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ROLE_LABELS, type Permission } from '@shared';
import {
  Building2,
  ChevronDown,
  GraduationCap,
  House,
  Inbox,
  LayoutDashboard,
  Library,
  ListTree,
  LogOut,
  MapPinned,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  School,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { usePendingRequestCount } from '@/features/people/api';
import { useCurrentSchool } from '@/features/school-profile/api';
import { useAuth, useSession } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  permission?: Permission;
  /** Hidden for users who hold this permission (they get a richer item instead). */
  hideWith?: Permission;
  end?: boolean;
  /** Extra condition on the signed-in person (for example, only those whose login is linked to an employee). */
  when?: (user: { role: string; personId: string | null }) => boolean;
  /** Shows the pending change-request count beside the label. */
  badge?: 'requests';
}

interface NavSection {
  label?: string;
  items: NavItem[];
}

/**
 * Navigation registry. Sections that are not built yet are simply not listed
 * (PRD §13: hide unavailable sections rather than exposing broken placeholders).
 */
const NAV: NavSection[] = [
  { items: [{ to: '/', label: 'Home', Icon: House, end: true }] },
  {
    label: 'School Setup',
    items: [
      {
        to: '/school-setup',
        label: 'Overview',
        Icon: LayoutDashboard,
        permission: 'setup:manage',
        end: true,
      },
      {
        to: '/school-setup/profile',
        label: 'School Profile',
        Icon: School,
        permission: 'school:view',
      },
      {
        to: '/school-setup/locations',
        label: 'Locations',
        Icon: MapPinned,
        permission: 'location:view',
      },
    ],
  },
  {
    label: 'Academics',
    items: [
      {
        to: '/academics',
        label: 'Academic Setup',
        Icon: GraduationCap,
        permission: 'academic:view_config',
        end: true,
      },
      {
        to: '/academics/subjects',
        label: 'Subject master',
        Icon: Library,
        permission: 'academic:view_config',
      },
      {
        to: '/academics',
        label: 'Academic Structure',
        Icon: GraduationCap,
        permission: 'academic:view',
        hideWith: 'academic:view_config',
        end: true,
      },
    ],
  },
  {
    label: 'People',
    items: [
      {
        to: '/people',
        label: 'Faculty & Staff',
        Icon: UsersRound,
        permission: 'employee:view',
        end: true,
      },
      {
        to: '/people/requests',
        label: 'Change requests',
        Icon: Inbox,
        permission: 'employee:approve_changes',
        badge: 'requests',
      },
      {
        to: '/people/settings',
        label: 'Departments & Designations',
        Icon: ListTree,
        permission: 'employee:manage',
      },
      {
        to: '/me',
        label: 'My Profile',
        Icon: UserRound,
        permission: 'employee:directory',
        when: (u) => u.role === 'FACULTY' || u.role === 'STAFF' || u.personId !== null,
      },
      {
        to: '/colleagues',
        label: 'Colleagues',
        Icon: UsersRound,
        permission: 'employee:directory',
        hideWith: 'employee:view',
      },
    ],
  },
];

/** Breadcrumb labels, longest match first. */
const CRUMBS: [string, string[]][] = [
  ['/academics/sessions/', ['Academics', 'Academic Setup', 'Session']],
  ['/academics/subjects', ['Academics', 'Subject master']],
  ['/school-setup/locations/', ['School Setup', 'Locations', 'Details']],
  ['/school-setup/locations', ['School Setup', 'Locations']],
  ['/school-setup/profile', ['School Setup', 'School Profile']],
  ['/people/requests', ['People', 'Change requests']],
  ['/people/settings', ['People', 'Departments & Designations']],
  ['/people/', ['People', 'Faculty & Staff', 'Profile']],
  ['/people', ['People', 'Faculty & Staff']],
  ['/me', ['People', 'My Profile']],
  ['/colleagues', ['People', 'Colleagues']],
];

function crumbsFor(pathname: string): string[] {
  if (pathname === '/') return ['Home'];
  if (pathname === '/school-setup') return ['School Setup', 'Overview'];
  if (pathname === '/academics') return ['Academics', 'Academic Setup'];
  return CRUMBS.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? ['Page'];
}

function SidebarContent({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const { can } = useAuth();
  const session = useSession();
  const pending = usePendingRequestCount(can('employee:approve_changes'));
  // Same cached query the profile page updates, so a new, replaced or removed logo shows here at once.
  const savedLogo = useCurrentSchool(can('school:view')).data?.logoUrl ?? null;
  // A logo whose file can't be loaded falls back to the icon instead of a broken image.
  const [brokenLogo, setBrokenLogo] = useState<string | null>(null);
  const logoUrl = savedLogo && savedLogo !== brokenLogo ? savedLogo : null;

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden bg-navy pt-5 pb-3 text-navy-text',
        collapsed ? 'px-2' : 'px-3',
      )}
    >
      <div
        title={collapsed ? session.tenant.name : undefined}
        className={cn(
          'mx-1 flex items-center gap-2.5 rounded-[10px] border border-[#284469] bg-navy-700 px-3 py-3',
          collapsed && 'justify-center px-0',
        )}
      >
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg',
            logoUrl ? 'bg-white' : 'bg-brand/30 text-brand-300',
          )}
        >
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={`${session.tenant.name} logo`}
              className="size-full object-cover object-center"
              onError={() => setBrokenLogo(logoUrl)}
            />
          ) : (
            <Building2 className="size-[18px]" />
          )}
        </span>
        <div className={cn('min-w-0', collapsed && 'hidden')}>
          <p className="truncate text-[13px] font-semibold text-white" title={session.tenant.name}>
            {session.tenant.name}
          </p>
          <p className="text-[11px] text-navy-muted">{ROLE_LABELS[session.user.role]} workspace</p>
        </div>
        <span
          className={cn('ml-auto size-1.5 shrink-0 rounded-full bg-mint', collapsed && 'hidden')}
          title="Workspace active"
        />
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto" aria-label="Main">
        {NAV.map((section, i) => {
          const items = section.items.filter(
            (item) =>
              (!item.permission || can(item.permission)) &&
              !(item.hideWith && can(item.hideWith)) &&
              (!item.when || item.when(session.user)),
          );
          if (items.length === 0) return null;
          return (
            <div key={section.label ?? i}>
              {section.label && !collapsed && (
                <p className="px-3.5 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-navy-muted uppercase">
                  {section.label}
                </p>
              )}
              <ul className={cn('space-y-0.5', collapsed ? 'mt-3' : 'mt-1.5')}>
                {items.map(({ to, label, Icon, end, badge }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      end={end}
                      onClick={onNavigate}
                      title={collapsed ? label : undefined}
                      aria-label={collapsed ? label : undefined}
                      className={({ isActive }) =>
                        cn(
                          collapsed && 'justify-center px-0',
                          'relative flex min-h-11 items-center gap-3 rounded-lg px-3.5 text-sm font-medium transition-colors hover:bg-white/5 hover:text-white',
                          isActive &&
                            'bg-navy-600 text-white before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[#5084ff]',
                        )
                      }
                    >
                      <Icon className="size-[18px] shrink-0" />
                      {!collapsed && label}
                      {badge === 'requests' && (pending.data ?? 0) > 0 && (
                        <span
                          className={cn(
                            'ml-auto grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold text-navy',
                            collapsed && 'absolute top-1.5 right-1.5 ml-0',
                          )}
                          aria-label={`${pending.data} pending`}
                        >
                          {pending.data}
                        </span>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function UserMenu() {
  const session = useSession();
  const { logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    // Hard redirect so no stale in-memory state can bounce the user back to '/'.
    window.location.replace('/login');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-full py-1 pr-2 pl-1 outline-none hover:bg-ink/5 focus-visible:ring-4 focus-visible:ring-brand/20">
        <Avatar name={session.user.fullName} />
        <span className="hidden text-left sm:block">
          <span className="block text-sm leading-tight font-semibold">{session.user.fullName}</span>
          <span className="block text-xs text-muted">{ROLE_LABELS[session.user.role]}</span>
        </span>
        <ChevronDown className="size-4 text-muted" aria-hidden="true" />
        <span className="sr-only">Open account menu</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <p className="text-sm font-semibold">{session.user.fullName}</p>
          <p className="truncate text-xs text-muted">{session.user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={handleLogout}
          className="text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger"
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sv.sidebar.collapsed') === '1',
  );
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem('sv.sidebar.collapsed', c ? '0' : '1');
      return !c;
    });
  const location = useLocation();
  const session = useSession();

  return (
    <div
      className={cn(
        'min-h-dvh transition-[padding] duration-200',
        collapsed ? 'md:pl-[72px]' : 'md:pl-[248px]',
      )}
    >
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-white px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 hidden transition-[width] duration-200 md:block',
          collapsed ? 'w-[72px]' : 'w-[248px]',
        )}
      >
        <SidebarContent collapsed={collapsed} />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent title="Main menu" className="md:hidden">
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <header className="sticky top-0 z-30 flex h-[62px] items-center gap-3 border-b border-line bg-white/85 px-4 backdrop-blur sm:h-[72px] sm:px-8">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="-ml-1.5 grid size-10 place-items-center rounded-lg text-ink hover:bg-ink/5 md:hidden"
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="hidden size-10 place-items-center rounded-lg text-ink hover:bg-ink/5 md:grid"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
        </button>
        <nav aria-label="Breadcrumb" className="min-w-0 truncate text-sm text-muted">
          <span className="hidden sm:inline">{session.tenant.name}</span>
          <span className="mx-2 hidden sm:inline" aria-hidden="true">
            /
          </span>
          {crumbsFor(location.pathname).map((crumb, i, all) => (
            <span key={crumb}>
              {i > 0 && (
                <span className="mx-2" aria-hidden="true">
                  /
                </span>
              )}
              <span
                className={i === all.length - 1 ? 'font-semibold text-ink' : undefined}
                aria-current={i === all.length - 1 ? 'page' : undefined}
              >
                {crumb}
              </span>
            </span>
          ))}
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
