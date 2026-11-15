import { useState } from 'react';
import { ROLE_DESCRIPTIONS } from '@shared';
import { Bus, Check, Copy, Flag, Fingerprint, History, MapPinned, School, ShieldCheck, Sparkles, Building } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { CampusScene } from '@/components/illustrations/campus-scene';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RoleBadge } from '@/components/sv/role-badge';
import { useSession } from '@/lib/auth';
import { cn, firstName, greetingFor } from '@/lib/utils';

const JOURNEY = [
  { label: 'School profile', hint: 'Name, contact & official IDs', Icon: School },
  { label: 'Primary campus', hint: 'Your main location', Icon: MapPinned },
  { label: 'More campuses', hint: 'Branches & admin offices', Icon: Building },
  { label: 'Go live', hint: 'Ready for academics', Icon: Flag },
];

const SAFEGUARDS = [
  { Icon: Fingerprint, title: 'Tenant-isolated', text: 'Your school’s data is walled off from every other workspace.' },
  { Icon: ShieldCheck, title: 'Server-enforced roles', text: 'Permissions are checked on the server, not just hidden in the UI.' },
  { Icon: History, title: 'Audit trail on', text: 'Configuration changes record who, when, and what changed.' },
];

function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value).catch(() => undefined);
        setCopied(true);
        toast.success('Workspace ID copied');
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-canvas px-2 py-1 font-mono text-xs text-muted hover:text-ink"
      aria-label="Copy workspace ID"
    >
      <span className="truncate">{value}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-success" /> : <Copy className="size-3.5 shrink-0" />}
    </button>
  );
}

export function HomePage() {
  const session = useSession();
  const isAdmin = session.user.role === 'SCHOOL_ADMIN';

  return (
    <div className="space-y-6">
      {/* Hero */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 160, damping: 20 }}
        className="relative overflow-hidden rounded-[20px] bg-navy px-6 py-8 text-white shadow-pop sm:px-10 sm:py-10"
      >
        <div className="pointer-events-none absolute -top-20 right-1/3 size-64 rounded-full bg-brand opacity-60 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 size-64 rounded-full bg-lavender opacity-30 blur-3xl" />
        <div className="relative grid items-center gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <Badge tone="sun" className="mb-4">
              <Sparkles /> Workspace ready
            </Badge>
            <h1 className="text-[28px] leading-tight font-extrabold sm:text-[34px]">
              {greetingFor()}, {firstName(session.user.fullName)} <span className="inline-block animate-wiggle origin-bottom">👋</span>
            </h1>
            <p className="mt-3 max-w-lg text-[15px] text-navy-text">
              Welcome to <strong className="text-white">{session.tenant.name}</strong> on SchoolVerse.{' '}
              {isAdmin
                ? 'Next you’ll set up your school profile and campuses. Everything else in the ERP builds on them.'
                : 'Your School Admin is setting up the school. You’ll see campuses and details here once they’re ready.'}
            </p>
          </div>
          <CampusScene className="mx-auto max-w-[420px] lg:-my-6" />
        </div>
      </motion.section>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Workspace */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Your workspace</CardTitle>
              <CardDescription>The tenant boundary for all your school data.</CardDescription>
            </div>
            <span className="grid size-10 place-items-center rounded-xl bg-brand-soft text-brand">
              <School className="size-5" />
            </span>
          </CardHeader>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted">Name</dt>
              <dd className="font-semibold">{session.tenant.name}</dd>
            </div>
            <div>
              <dt className="text-muted">Workspace ID</dt>
              <dd className="mt-1">
                <CopyId value={session.tenant.tenantId} />
              </dd>
            </div>
            <div>
              <dt className="text-muted">Status</dt>
              <dd className="mt-1">
                <Badge tone="success">
                  <Check /> Active
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>

        {/* Role */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Your role</CardTitle>
              <CardDescription>{ROLE_DESCRIPTIONS[session.user.role]}</CardDescription>
            </div>
          </CardHeader>
          <RoleBadge role={session.user.role} />
          <p className="mt-4 text-sm text-muted">
            {session.permissions.length > 0
              ? `You have ${session.permissions.length} permission${session.permissions.length === 1 ? '' : 's'} in this workspace:`
              : 'Your role has no access to school configuration.'}
          </p>
          <ul className="mt-2.5 flex flex-wrap gap-1.5">
            {session.permissions.map((p) => (
              <li key={p} className="rounded-md bg-canvas px-2 py-1 font-mono text-[11px] text-muted">
                {p}
              </li>
            ))}
          </ul>
        </Card>

        {/* Safeguards */}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Built-in safeguards</CardTitle>
              <CardDescription>Active from day one.</CardDescription>
            </div>
          </CardHeader>
          <ul className="space-y-4">
            {SAFEGUARDS.map(({ Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-mint-soft text-success">
                  <Icon className="size-[18px]" />
                </span>
                <div>
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="text-[13px] text-muted">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Journey */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Your setup journey</CardTitle>
            <CardDescription>
              {isAdmin ? 'Here’s the route to a fully configured school. The guided setup unlocks in the next release.' : 'Here’s what your School Admin will configure.'}
            </CardDescription>
          </div>
          <Badge tone="lavender">Coming next</Badge>
        </CardHeader>
        <ol className="relative grid gap-4 sm:grid-cols-4 sm:gap-2">
          <div className="absolute top-6 right-[12%] left-[12%] hidden h-1 rounded-full bg-[repeating-linear-gradient(90deg,var(--color-line)_0_12px,transparent_12px_20px)] sm:block" aria-hidden="true" />
          <motion.div
            className="absolute top-1 left-[8%] hidden text-sun sm:block"
            animate={{ x: [0, 14, 0] }}
            transition={{ repeat: Infinity, duration: 3, ease: 'easeInOut' }}
            aria-hidden="true"
          >
            <Bus className="size-6 drop-shadow" />
          </motion.div>
          {JOURNEY.map(({ label, hint, Icon }, i) => (
            <li key={label} className="relative flex items-center gap-3 sm:flex-col sm:text-center">
              <span
                className={cn(
                  'relative z-10 grid size-12 shrink-0 place-items-center rounded-2xl border-2 border-white shadow-card',
                  ['bg-brand-soft text-brand', 'bg-coral-soft text-coral', 'bg-lavender-soft text-lavender', 'bg-mint-soft text-mint'][i],
                )}
              >
                <Icon className="size-5" />
              </span>
              <div>
                <p className="text-sm font-semibold">
                  <span className="text-muted">{i + 1}.</span> {label}
                </p>
                <p className="text-[13px] text-muted">{hint}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
