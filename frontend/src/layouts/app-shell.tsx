import { useState, type ComponentType } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS, type Permission } from '@shared';
import { Building2, ChevronDown, House, LogOut, MapPinned, Menu, Rocket, School, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Logo } from '@/components/sv/logo';
import { RoleBadge } from '@/components/sv/role-badge';
import { useAuth, useSession } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  permission?: Permission;
  end?: boolean;
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
      { to: '/school-setup/profile', label: 'School Profile', Icon: School, permission: 'school:view' },
      { to: '/school-setup/locations', label: 'Locations', Icon: MapPinned, permission: 'location:view' },
    ],
  },
];

/** Breadcrumb labels, longest match first. */
const CRUMBS: [string, string[]][] = [
  ['/school-setup/locations/', ['School Setup', 'Locations', 'Details']],
  ['/school-setup/locations', ['School Setup', 'Locations']],
  ['/school-setup/profile', ['School Setup', 'School Profile']],
];

function crumbsFor(pathname: string): string[] {
  if (pathname === '/') return ['Home'];
  return CRUMBS.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? ['Page'];
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useAuth();
  const session = useSession();

  return (
    <div className="flex h-full flex-col bg-navy px-3 pt-5 pb-3 text-navy-text">
      <div className="px-2.5 pb-6">
        <Logo tone="light" />
      </div>

      <div className="mx-1 flex items-center gap-2.5 rounded-[10px] border border-[#284469] bg-navy-700 px-3 py-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand/30 text-brand-300">
          <Building2 className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white" title={session.tenant.name}>
            {session.tenant.name}
          </p>
          <p className="text-xs text-navy-muted">{ROLE_LABELS[session.user.role]} workspace</p>
        </div>
        <span className="ml-auto size-1.5 shrink-0 rounded-full bg-mint" title="Workspace active" />
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto" aria-label="Main">
        {NAV.map((section, i) => {
          const items = section.items.filter((item) => !item.permission || can(item.permission));
          if (items.length === 0) return null;
          return (
            <div key={section.label ?? i}>
              {section.label && <p className="px-3.5 pt-5 pb-2.5 text-[11px] font-semibold tracking-[0.12em] text-navy-muted uppercase">{section.label}</p>}
              <ul className="mt-3 space-y-0.5">
                {items.map(({ to, label, Icon, end }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      end={end}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn(
                          'relative flex min-h-11 items-center gap-3 rounded-lg px-3.5 text-sm font-medium transition-colors hover:bg-white/5 hover:text-white',
                          isActive && 'bg-navy-600 text-white before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[#5084ff]',
                        )
                      }
                    >
                      <Icon className="size-[18px]" />
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="mx-1 mb-3 rounded-[10px] border border-[#2d4160] p-3.5 text-[13px]">
        <Rocket className="mb-2 size-[18px] text-[#85a7e5]" />
        <p className="font-semibold text-[#e3eafb]">Coming next</p>
        <p className="mt-1 leading-relaxed text-navy-muted">Guided setup, the school overview and academic structure.</p>
      </div>

      <div className="flex items-center justify-between border-t border-[#2a3d5b] px-2 pt-3">
        <div>
          <p className="text-[13px] font-semibold text-[#e3eafb]">SchoolVerse ERP</p>
          <p className="text-[11px] text-navy-muted">Module 1 · School Setup</p>
        </div>
        <span className="rounded-[5px] border border-[#455b7b] px-1.5 py-0.5 text-[11px] text-[#c8d8f0]">v0.1</span>
      </div>
    </div>
  );
}

function UserMenu() {
  const session = useSession();
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    toast.success('Signed out. See you soon! 👋');
    navigate('/login', { replace: true });
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
          <div className="mt-2">
            <RoleBadge role={session.user.role} />
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <UserRound /> My profile <span className="ml-auto text-[11px] text-muted">Soon</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleLogout} className="text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger">
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const session = useSession();

  return (
    <div className="min-h-dvh md:pl-[248px]">
      <a href="#main" className="sr-only z-50 rounded-lg bg-white px-4 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 hidden w-[248px] md:block">
        <SidebarContent />
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
              <span className={i === all.length - 1 ? 'font-semibold text-ink' : undefined} aria-current={i === all.length - 1 ? 'page' : undefined}>
                {crumb}
              </span>
            </span>
          ))}
        </nav>
        <div className="ml-auto">
          <UserMenu />
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-8 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
