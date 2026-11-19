import type { ComponentType } from 'react';
import { Link } from 'react-router';
import { ROLE_LABELS, type Permission } from '@shared';
import {
  ArrowRight,
  GraduationCap,
  Inbox,
  LayoutDashboard,
  Library,
  ListTree,
  MapPinned,
  School,
  Sparkles,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { motion } from 'motion/react';
import { CampusScene } from '@/components/illustrations/campus-scene';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useAuth, useSession } from '@/lib/auth';
import { firstName, greetingFor } from '@/lib/utils';

interface QuickLink {
  to: string;
  title: string;
  text: string;
  Icon: ComponentType<{ className?: string }>;
  tint: string;
  permission: Permission;
  /** Hidden for users who hold this permission (they get a richer link instead). */
  hideWith?: Permission;
  when?: (user: { role: string; personId: string | null }) => boolean;
}

/** Mirrors the sidebar: each link only appears for people who can open that section. */
const QUICK_LINKS: QuickLink[] = [
  {
    to: '/school-setup',
    title: 'Finish setting up your school',
    text: 'See what’s done and what’s left to get your school ready.',
    Icon: LayoutDashboard,
    tint: 'bg-brand-soft text-brand',
    permission: 'setup:manage',
  },
  {
    to: '/school-setup/profile',
    title: 'School profile',
    text: 'Keep your school’s name, address, contact details and branding up to date.',
    Icon: School,
    tint: 'bg-lavender-soft text-lavender',
    permission: 'school:view',
  },
  {
    to: '/school-setup/locations',
    title: 'Campuses & locations',
    text: 'Add and manage your campuses, buildings and other school locations.',
    Icon: MapPinned,
    tint: 'bg-mint-soft text-success',
    permission: 'location:view',
  },
  {
    to: '/academics',
    title: 'Academic setup',
    text: 'Plan academic years, terms, classes and sections.',
    Icon: GraduationCap,
    tint: 'bg-sun-soft text-warning',
    permission: 'academic:view_config',
  },
  {
    to: '/academics/subjects',
    title: 'Subjects',
    text: 'Maintain the list of subjects your school teaches.',
    Icon: Library,
    tint: 'bg-coral-soft text-coral',
    permission: 'academic:view_config',
  },
  {
    to: '/academics',
    title: 'Academic structure',
    text: 'Browse the school’s academic years, classes and sections.',
    Icon: GraduationCap,
    tint: 'bg-sun-soft text-warning',
    permission: 'academic:view',
    hideWith: 'academic:view_config',
  },
  {
    to: '/people',
    title: 'Faculty & staff',
    text: 'Find people, view their profiles and add new team members.',
    Icon: UsersRound,
    tint: 'bg-brand-soft text-brand',
    permission: 'employee:view',
  },
  {
    to: '/people/requests',
    title: 'Review change requests',
    text: 'Approve or decline profile updates your team has asked for.',
    Icon: Inbox,
    tint: 'bg-coral-soft text-coral',
    permission: 'employee:approve_changes',
  },
  {
    to: '/people/settings',
    title: 'Departments & designations',
    text: 'Organise your team into departments and job titles.',
    Icon: ListTree,
    tint: 'bg-lavender-soft text-lavender',
    permission: 'employee:manage',
  },
  {
    to: '/me',
    title: 'My profile',
    text: 'Check your details and ask for changes if something is out of date.',
    Icon: UserRound,
    tint: 'bg-mint-soft text-success',
    permission: 'employee:directory',
    when: (u) => u.role === 'FACULTY' || u.role === 'STAFF' || u.personId !== null,
  },
  {
    to: '/colleagues',
    title: 'Colleagues',
    text: 'Look up your colleagues and how to reach them.',
    Icon: UsersRound,
    tint: 'bg-brand-soft text-brand',
    permission: 'employee:directory',
    hideWith: 'employee:view',
  },
];

export function HomePage() {
  const session = useSession();
  const { can } = useAuth();
  const links = QUICK_LINKS.filter(
    (l) =>
      can(l.permission) &&
      !(l.hideWith && can(l.hideWith)) &&
      (!l.when || l.when(session.user)),
  );

  return (
    <div className="space-y-6">
      {/* Hero */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 160, damping: 20 }}
        className="relative overflow-hidden rounded-[20px] bg-navy px-6 py-6 text-white shadow-pop sm:px-10 sm:py-8"
      >
        <div className="pointer-events-none absolute -top-20 right-1/3 size-64 rounded-full bg-brand opacity-60 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 size-64 rounded-full bg-lavender opacity-30 blur-3xl" />
        <div className="relative grid items-center gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <Badge tone="sun" className="mb-4">
              <Sparkles /> {ROLE_LABELS[session.user.role]} Workspace
            </Badge>
            <h1 className="text-[28px] leading-tight font-extrabold sm:text-[34px]">
              {greetingFor()}, {firstName(session.user.fullName)} <span className="inline-block animate-wiggle origin-bottom">👋</span>
            </h1>
            <p className="mt-3 max-w-lg text-[15px] text-navy-text">
              Welcome to <strong className="text-white">{session.tenant.name}</strong> on SchoolVerse.
            </p>
          </div>
          <CampusScene className="mx-auto max-w-[340px] lg:-my-5" />
        </div>
      </motion.section>

      <section aria-labelledby="home-actions">
        <h2 id="home-actions" className="text-lg font-bold text-ink">
          What you can do
        </h2>
        <p className="mt-0.5 text-sm text-muted">Jump straight to the part of SchoolVerse you need.</p>

        {links.length > 0 ? (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {links.map(({ to, title, text, Icon, tint }) => (
              <li key={`${to}-${title}`}>
                <Link
                  to={to}
                  className="group flex h-full items-start gap-3.5 rounded-card border border-line bg-white p-5 shadow-card outline-none transition hover:-translate-y-0.5 hover:border-brand/40 focus-visible:ring-4 focus-visible:ring-brand/20"
                >
                  <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${tint}`}>
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-ink">{title}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">{text}</span>
                  </span>
                  <ArrowRight
                    className="mt-1 size-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Card className="mt-4">
            <p className="text-sm text-muted">
              There’s nothing for you to manage here just yet. Your School Admin is setting things up, and
              you’ll see more here as soon as they’re ready.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
