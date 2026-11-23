import { useEffect, useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ROLE_LABELS, type Permission } from '@shared';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  GraduationCap,
  IndianRupee,
  Banknote,
  BookOpenCheck,
  Landmark,
  Percent,
  ShoppingCart,
  Wallet,
  Inbox,
  LayoutDashboard,
  Library,
  ListTree,
  ListChecks,
  LogOut,
  DoorOpen,
  DoorClosed,
  Shapes,
  FileUp,
  FileBarChart,
  LayoutGrid,
  Repeat,
  Rocket,
  MapPinned,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptText,
  School,
  Settings2,
  UserRound,
  UsersRound,
  Users,
} from 'lucide-react';
import { SchoolLogo } from '@/components/sv/school-logo';
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
import { Tooltip } from '@/components/ui/tooltip';
import { usePendingRequestCount } from '@/features/people/api';
import { useFinanceAttentionCount } from '@/features/finance/attention-page';
import { FinanceSearch } from '@/features/finance/finance-search';
import { useSpaceAttentionCount } from '@/features/spaces/attention';
import { useAttentionCount } from '@/features/students/api';
import { usePendingStudentRequests } from '@/features/students/lifecycle-api';
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
  when?: (user: { role: string; personId: string | null }, can: (p: Permission) => boolean) => boolean;
  /** Shows the pending change-request count beside the label. */
  badge?: 'requests' | 'attention' | 'student-requests' | 'space-attention' | 'finance-attention';
}

interface NavSection {
  label?: string;
  items: NavItem[];
}

const PAYROLL_READ: Permission[] = ['payroll:setup:manage', 'payroll:structure:manage', 'payroll:input:manage', 'payroll:run:prepare', 'payroll:run:approve', 'payroll:disbursement:manage', 'payroll:disbursement:verify', 'payroll:report:view'];

/**
 * Navigation registry. Sections that are not built yet are simply not listed
 * (PRD §13: hide unavailable sections rather than exposing broken placeholders).
 */
const NAV: NavSection[] = [
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
    label: 'Students',
    items: [
      { to: '/students', label: 'Students', Icon: Users, permission: 'student:view', end: true },
      { to: '/students/attention', label: 'Needs Attention', Icon: ListChecks, permission: 'student:view', badge: 'attention' },
      { to: '/families', label: 'Families', Icon: UsersRound, permission: 'student:view' },
      { to: '/students/requests', label: 'Parent requests', Icon: Inbox, permission: 'student:approve_changes', badge: 'student-requests' },
      { to: '/students/promotion', label: 'Promotion', Icon: Rocket, permission: 'student:lifecycle' },
      { to: '/students/exits', label: 'Transfers & Exits', Icon: DoorOpen, permission: 'student:lifecycle' },
      { to: '/students/imports', label: 'Imports', Icon: FileUp, permission: 'student:import' },
      { to: '/my-students', label: 'My Students', Icon: Users, when: (u) => u.role === 'FACULTY' },
    ],
  },
  {
    label: 'Campus',
    items: [
      { to: '/spaces', label: 'Space Setup', Icon: Building2, permission: 'space:edit', end: true },
      { to: '/spaces', label: 'Rooms', Icon: DoorClosed, permission: 'space:view', hideWith: 'space:edit', end: true },
      { to: '/spaces/allocation', label: 'Classroom Allocation', Icon: LayoutGrid, permission: 'space:section_assignment:manage' },
      { to: '/spaces/attention', label: 'Needs Attention', Icon: ListChecks, permission: 'space:edit', badge: 'space-attention' },
      { to: '/spaces/rollover', label: 'Rollover', Icon: Repeat, permission: 'space:section_assignment:manage' },
      { to: '/spaces/reports', label: 'Reports', Icon: FileBarChart, permission: 'space:export' },
      { to: '/spaces/types', label: 'Room Types', Icon: Shapes, permission: 'space:edit' },
      { to: '/spaces/imports', label: 'Imports', Icon: FileUp, permission: 'space:import' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { to: '/finance', label: 'Overview', Icon: IndianRupee, permission: 'finance:view', end: true },
      { to: '/finance/attention', label: 'Needs Attention', Icon: ListChecks, permission: 'finance:view', badge: 'finance-attention' },
      { to: '/finance/fees', label: 'Student Fees', Icon: ReceiptText, permission: 'finance:view' },
      { to: '/finance/collect', label: 'Collect Payments', Icon: Banknote, permission: 'finance:view' },
      { to: '/finance/payroll', label: 'Payroll', Icon: Wallet, permission: 'finance:view', when: (_u, can) => PAYROLL_READ.some(can) },
      { to: '/finance/expenses', label: 'Expenses', Icon: ShoppingCart, permission: 'finance:expense:record' },
      { to: '/finance/banking', label: 'Banking', Icon: Landmark, permission: 'finance:reconciliation:manage' },
      { to: '/finance/tax', label: 'Tax & GST', Icon: Percent, permission: 'finance:view', when: (_u, can) => can('finance:tax:review') || can('finance:tax:manage') || can('finance:report:view') },
      { to: '/finance/accounting', label: 'Accounting & Reports', Icon: BookOpenCheck, permission: 'finance:view', when: (_u, can) => can('finance:accounting:view') || can('finance:report:view') || can('finance:period:close') },
      { to: '/finance/settings', label: 'Settings', Icon: Settings2, permission: 'finance:view' },
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
        to: '/me/salary',
        label: 'My Salary',
        Icon: Wallet,
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
  ['/finance/attention', ['Finance', 'Needs Attention']],
  ['/finance/collect', ['Finance', 'Collect Payments']],
  ['/finance/payroll', ['Finance', 'Payroll']],
  ['/finance/expenses', ['Finance', 'Expenses']],
  ['/finance/banking/imports/', ['Finance', 'Banking', 'Statement']],
  ['/finance/banking', ['Finance', 'Banking']],
  ['/finance/tax', ['Finance', 'Tax & GST']],
  ['/finance/accounting', ['Finance', 'Accounting & Reports']],
  ['/me/salary', ['People', 'My Salary']],
  ['/finance/fees/students/', ['Finance', 'Student Fees', 'Student Account']],
  ['/finance/fees', ['Finance', 'Student Fees']],
  ['/finance/settings', ['Finance', 'Settings']],
  ['/finance', ['Finance', 'Overview']],
  ['/spaces/allocation', ['Campus', 'Classroom Allocation']],
  ['/spaces/rollover', ['Campus', 'Rollover']],
  ['/spaces/reports', ['Campus', 'Reports']],
  ['/spaces/attention', ['Campus', 'Needs Attention']],
  ['/spaces/types', ['Campus', 'Room Types']],
  ['/spaces/imports/', ['Campus', 'Imports', 'Import']],
  ['/spaces/imports', ['Campus', 'Imports']],
  ['/spaces', ['Campus', 'Space Setup']],
  ['/students/attention', ['Students', 'Needs Attention']],
  ['/students/requests', ['Students', 'Parent requests']],
  ['/students/promotion', ['Students', 'Promotion']],
  ['/students/exits', ['Students', 'Transfers & Exits']],
  ['/students/imports/', ['Students', 'Imports', 'Import']],
  ['/students/imports', ['Students', 'Imports']],
  ['/students/new', ['Students', 'Add Student']],
  ['/students/', ['Students', 'Student']],
  ['/students', ['Students', 'Students']],
  ['/families/', ['Students', 'Families', 'Family']],
  ['/families', ['Students', 'Families']],
  ['/my-students', ['Students', 'My Students']],
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

/** Which groups are open lasts for one sign-in only (sessionStorage, cleared on sign-out), so every new login starts collapsed. */
const GROUPS_KEY = 'sv.sidebar.openGroups';

function readOpenGroups(): string[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(GROUPS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Shows a styled tooltip to the right of an icon, only while the sidebar is collapsed. */
export function CollapsedTip({ label, active, children }: { label: string; active: boolean; children: React.ReactElement }) {
  return active ? (
    <Tooltip content={label} side="right">
      {children}
    </Tooltip>
  ) : (
    children
  );
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
  const { pathname } = useLocation();
  const [open, setOpen] = useState<string[]>(readOpenGroups);
  const setGroupOpen = (label: string, isOpen: boolean) =>
    setOpen((prev) => {
      const next = isOpen ? [...new Set([...prev, label])] : prev.filter((l) => l !== label);
      sessionStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  // Opening a page (by link, bookmark or back button) reveals the group it lives in.
  useEffect(() => {
    const active = NAV.find(
      (section) =>
        section.label &&
        section.items.some((item) =>
          item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
        ),
    )?.label;
    if (active) setOpen((prev) => (prev.includes(active) ? prev : [...prev, active]));
  }, [pathname]);
  const pending = usePendingRequestCount(can('employee:approve_changes'));
  const attention = useAttentionCount(can('student:view'), {});
  const spaceAttention = useSpaceAttentionCount(can('space:edit'));
  const financeAttention = useFinanceAttentionCount();
  const studentRequests = usePendingStudentRequests(can('student:approve_changes'));
  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden bg-navy pt-5 pb-3 text-navy-text',
        collapsed ? 'px-2' : 'px-3',
      )}
    >
      {/* The school card is the Home link. */}
      <CollapsedTip label={`${session.tenant.name} – Home`} active={collapsed}>
        <div>
      <NavLink
        to="/"
        end
        onClick={onNavigate}
        title={collapsed ? undefined : 'Home'}
        aria-label={`${session.tenant.name} – Home`}
        className={({ isActive }) =>
          cn(
            'mx-1 flex items-center gap-2.5 rounded-[10px] border bg-navy-700 px-3 py-3 transition-colors hover:bg-navy-600 focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none',
            isActive ? 'border-[#5084ff]' : 'border-[#284469]',
            collapsed && 'justify-center px-0',
          )
        }
      >
        <SchoolLogo schoolName={session.tenant.name} />
        <div className={cn('min-w-0', collapsed && 'hidden')}>
          <p className="truncate text-[13px] font-semibold text-white" title={session.tenant.name}>
            {session.tenant.name}
          </p>
          <p className="text-[11px] text-navy-muted">{ROLE_LABELS[session.user.role]} workspace</p>
        </div>
      </NavLink>
        </div>
      </CollapsedTip>

      <nav className="scrollbar-minimal mt-2 flex-1 overflow-y-auto" aria-label="Main">
        {NAV.map((section, i) => {
          const items = section.items.filter(
            (item) =>
              (!item.permission || can(item.permission)) &&
              !(item.hideWith && can(item.hideWith)) &&
              (!item.when || item.when(session.user, can)),
          );
          if (items.length === 0) return null;
          const label = section.label;
          // Icon-only mode has no headers, so every item stays visible.
          const isOpen = !label || collapsed || open.includes(label);
          const groupId = `nav-group-${i}`;
          const hiddenBadgeTotal = !isOpen
            ? items.reduce(
                (sum, item) =>
                  sum +
                  (item.badge === 'attention'
                    ? (attention.data ?? 0)
                    : item.badge === 'finance-attention'
                      ? financeAttention
                    : item.badge === 'space-attention'
                      ? spaceAttention
                    : item.badge === 'student-requests'
                      ? (studentRequests.data ?? 0)
                      : item.badge === 'requests'
                        ? (pending.data ?? 0)
                        : 0),
                0,
              )
            : 0;
          return (
            <div key={label ?? i}>
              {label && !collapsed && (
                <button
                  type="button"
                  onClick={() => setGroupOpen(label, !isOpen)}
                  aria-expanded={isOpen}
                  aria-controls={groupId}
                  className={cn(
                    'mt-2.5 flex min-h-9 w-full items-center gap-1.5 rounded-lg border px-3 text-left text-[11px] font-semibold tracking-[0.12em] uppercase transition-colors hover:bg-navy-600 hover:text-white focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:outline-none',
                    isOpen
                      ? 'border-[#284469] bg-navy-700 text-white'
                      : 'border-transparent bg-white/[0.04] text-navy-muted',
                  )}
                >
                  <ChevronRight
                    className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                    aria-hidden="true"
                  />
                  {label}
                  {hiddenBadgeTotal > 0 && (
                    <span
                      className="ml-auto grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold tracking-normal text-navy"
                      aria-label={`${hiddenBadgeTotal} waiting`}
                    >
                      {hiddenBadgeTotal}
                    </span>
                  )}
                </button>
              )}
              <ul
                id={groupId}
                hidden={!isOpen}
                className={cn('space-y-0.5', collapsed ? 'mt-3' : 'mt-1.5')}
              >
                {items.map(({ to, label: itemLabel, Icon, end, badge }) => (
                  <li key={to}>
                    <CollapsedTip label={itemLabel} active={collapsed}>
                    <NavLink
                      to={to}
                      end={end}
                      onClick={onNavigate}
                      aria-label={collapsed ? itemLabel : undefined}
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
                      {!collapsed && itemLabel}
                      {!collapsed && badge === 'attention' && (attention.data ?? 0) > 0 && (
                        <span
                          className={cn(
                            'ml-auto grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold text-navy',
                            collapsed && 'absolute top-1.5 right-1.5 ml-0',
                          )}
                          aria-label={`${attention.data} need attention`}
                        >
                          {attention.data}
                        </span>
                      )}
                      {!collapsed && badge === 'finance-attention' && financeAttention > 0 && (
                        <span
                          className="ml-auto grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold text-navy"
                          aria-label={`${financeAttention} things need attention`}
                        >
                          {financeAttention}
                        </span>
                      )}
                      {!collapsed && badge === 'space-attention' && spaceAttention > 0 && (
                        <span
                          className="ml-auto grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold text-navy"
                          aria-label={`${spaceAttention} things need attention`}
                        >
                          {spaceAttention}
                        </span>
                      )}
                      {!collapsed && badge === 'student-requests' && (studentRequests.data ?? 0) > 0 && (
                        <span
                          className={cn(
                            'ml-auto grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold text-navy',
                            collapsed && 'absolute top-1.5 right-1.5 ml-0',
                          )}
                          aria-label={`${studentRequests.data} pending`}
                        >
                          {studentRequests.data}
                        </span>
                      )}
                      {!collapsed && badge === 'requests' && (pending.data ?? 0) > 0 && (
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
                    </CollapsedTip>
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

/** The avatar + Sign out menu in the top bar. Shared with the parent portal so every portal looks the same. */
export function UserMenu() {
  const session = useSession();
  const { logout } = useAuth();

  const handleLogout = async () => {
    sessionStorage.removeItem(GROUPS_KEY);
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
        <div className="ml-auto flex items-center gap-3">
          <FinanceSearch />
          <UserMenu />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1280px] px-4 py-5 sm:px-8 sm:py-6">
        <Outlet />
      </main>
    </div>
  );
}
