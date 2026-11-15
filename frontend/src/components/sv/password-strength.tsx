import { Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

const RULES = [
  { label: '8+ characters', test: (v: string) => v.length >= 8 },
  { label: 'A letter', test: (v: string) => /[A-Za-z]/.test(v) },
  { label: 'A number', test: (v: string) => /[0-9]/.test(v) },
  { label: 'A symbol (bonus)', test: (v: string) => /[^A-Za-z0-9]/.test(v) },
];

const LEVELS = [
  { label: 'Too weak', bar: 'bg-danger', text: 'text-danger' },
  { label: 'Getting there', bar: 'bg-coral', text: 'text-[#b4401f]' },
  { label: 'Almost', bar: 'bg-sun', text: 'text-[#7a5300]' },
  { label: 'Solid 💪', bar: 'bg-mint', text: 'text-success' },
  { label: 'Super strong 🚀', bar: 'bg-success', text: 'text-success' },
];

export function PasswordStrength({ value }: { value: string }) {
  const passed = RULES.map((r) => r.test(value));
  const score = value ? passed.filter(Boolean).length : 0;
  const level = LEVELS[score]!;
  return (
    <div className="-mt-1 space-y-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn('h-1.5 flex-1 rounded-full transition-colors', i < score ? level.bar : 'bg-ink/10')} />
          ))}
        </div>
        {value && <span className={cn('text-xs font-semibold', level.text)}>{level.label}</span>}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {RULES.map((r, i) => (
          <li key={r.label} className={cn('flex items-center gap-1.5 text-xs', passed[i] ? 'text-success' : 'text-muted')}>
            {passed[i] ? <Check className="size-3.5" aria-hidden="true" /> : <Circle className="size-3" aria-hidden="true" />}
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
