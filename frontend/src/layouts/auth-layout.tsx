import { Outlet } from 'react-router';
import { motion } from 'motion/react';
import { MapPin, ShieldCheck, Sparkles } from 'lucide-react';
import { CampusScene } from '@/components/illustrations/campus-scene';
import { Logo } from '@/components/sv/logo';

const CHIPS = [
  { Icon: MapPin, text: 'Every campus, one source of truth', cls: 'left-6 top-[18%] bg-white text-ink', delay: 0.3 },
  { Icon: ShieldCheck, text: 'Your data stays in your school', cls: 'right-6 top-[38%] bg-sun text-navy', delay: 0.5 },
  { Icon: Sparkles, text: 'Set up in minutes, not months', cls: 'left-10 bottom-[30%] bg-lavender text-white', delay: 0.7 },
];

export function AuthLayout() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-5 py-6 sm:px-10 lg:px-14">
        <Logo />
        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[420px]">
            <Outlet />
          </div>
        </main>
        <p className="text-center text-xs text-muted lg:text-left">© {new Date().getFullYear()} SchoolVerse · The friendly School ERP</p>
      </div>

      <aside className="relative hidden overflow-hidden bg-navy lg:flex lg:flex-col lg:justify-between lg:p-12" aria-hidden="true">
        <div className="pointer-events-none absolute -top-24 -right-24 size-80 rounded-full bg-brand opacity-50 blur-3xl" />
        <div className="pointer-events-none absolute bottom-10 -left-20 size-72 rounded-full bg-lavender opacity-25 blur-3xl" />

        <div className="relative">
          <p className="text-[11px] font-bold tracking-[0.18em] text-brand-300 uppercase">School setup, sorted</p>
          <h2 className="mt-3 max-w-md text-[38px] leading-[1.1] font-extrabold text-white">
            One school. Every campus. <span className="text-sun">Zero chaos.</span>
          </h2>
          <p className="mt-4 max-w-md text-[15px] text-navy-text">
            Set up your school and campuses once. Staff, students, fees and timetables all use the same records from day one.
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-[560px]">
          <CampusScene />
          {CHIPS.map(({ Icon, text, cls, delay }) => (
            <motion.div
              key={text}
              initial={{ opacity: 0, y: 12, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay, type: 'spring', stiffness: 220, damping: 18 }}
              className={`absolute flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold shadow-pop ${cls}`}
            >
              <Icon className="size-4" />
              {text}
            </motion.div>
          ))}
        </div>
      </aside>
    </div>
  );
}
