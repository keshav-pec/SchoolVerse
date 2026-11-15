import { cn } from '@/lib/utils';

/** Playful multi-campus illustration: a school, two branch buildings, map pins and the school bus. */
export function CampusScene({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 320" className={cn('h-auto w-full', className)} role="img" aria-label="Illustration of a school with several campuses connected by a road">
      {/* sky glow */}
      <circle cx="390" cy="70" r="34" fill="#FFC940" />
      <circle cx="390" cy="70" r="50" fill="#FFC940" opacity="0.18" />
      {/* clouds */}
      <g fill="#fff" opacity="0.9">
        <rect x="58" y="52" width="86" height="22" rx="11" />
        <rect x="80" y="40" width="44" height="24" rx="12" />
        <rect x="292" y="104" width="66" height="18" rx="9" opacity="0.7" />
      </g>
      {/* hills */}
      <path d="M0 250c70-40 140-48 220-26s170 20 260-18v114H0Z" fill="#15305a" />
      <path d="M0 268c90-22 170-18 250 2s150 16 230-6v56H0Z" fill="#193663" />
      {/* road */}
      <path d="M-10 296c120-30 230-34 330-14s120 16 170 8" fill="none" stroke="#2c4a7c" strokeWidth="22" strokeLinecap="round" />
      <path d="M-10 296c120-30 230-34 330-14s120 16 170 8" fill="none" stroke="#FFC940" strokeWidth="2.5" strokeDasharray="10 12" strokeLinecap="round" />

      {/* main campus */}
      <g>
        <rect x="170" y="150" width="140" height="96" rx="6" fill="#fff" />
        <path d="M160 156 240 112l80 44Z" fill="#244FD4" />
        <rect x="232" y="84" width="3" height="30" fill="#c6d2e6" />
        <path d="M235 86h22l-6 7 6 7h-22Z" fill="#FF7A59" />
        <circle cx="240" cy="140" r="11" fill="#fff" stroke="#244FD4" strokeWidth="3" />
        <path d="M240 134v6l4 3" stroke="#15233B" strokeWidth="2" strokeLinecap="round" fill="none" />
        <rect x="224" y="206" width="32" height="40" rx="4" fill="#244FD4" />
        <g fill="#EEF4FF">
          <rect x="184" y="168" width="22" height="18" rx="3" />
          <rect x="274" y="168" width="22" height="18" rx="3" />
          <rect x="184" y="200" width="22" height="18" rx="3" />
          <rect x="274" y="200" width="22" height="18" rx="3" />
        </g>
      </g>

      {/* branch campus left */}
      <g>
        <rect x="58" y="192" width="78" height="58" rx="5" fill="#EEF4FF" />
        <path d="M52 196 97 168l45 28Z" fill="#8B7CF6" />
        <rect x="88" y="222" width="18" height="28" rx="3" fill="#8B7CF6" />
        <rect x="68" y="206" width="14" height="12" rx="2" fill="#fff" />
        <rect x="112" y="206" width="14" height="12" rx="2" fill="#fff" />
      </g>

      {/* branch campus right */}
      <g>
        <rect x="350" y="186" width="84" height="62" rx="5" fill="#EEF4FF" />
        <path d="M344 190 392 162l48 28Z" fill="#2BC48A" />
        <rect x="382" y="218" width="20" height="30" rx="3" fill="#2BC48A" />
        <rect x="360" y="200" width="14" height="12" rx="2" fill="#fff" />
        <rect x="410" y="200" width="14" height="12" rx="2" fill="#fff" />
      </g>

      {/* trees */}
      <g>
        <rect x="150" y="226" width="4" height="22" fill="#0d1f3d" />
        <circle cx="152" cy="220" r="13" fill="#2BC48A" />
        <rect x="326" y="226" width="4" height="22" fill="#0d1f3d" />
        <circle cx="328" cy="218" r="15" fill="#2BC48A" />
        <circle cx="448" cy="232" r="10" fill="#2BC48A" opacity="0.8" />
      </g>

      {/* map pins */}
      <g className="animate-float">
        <path d="M97 120c-11 0-19 8-19 18 0 13 19 30 19 30s19-17 19-30c0-10-8-18-19-18Z" fill="#FF7A59" />
        <circle cx="97" cy="138" r="7" fill="#fff" />
      </g>
      <g className="animate-float-slow">
        <path d="M392 112c-11 0-19 8-19 18 0 13 19 30 19 30s19-17 19-30c0-10-8-18-19-18Z" fill="#FF7A59" />
        <circle cx="392" cy="130" r="7" fill="#fff" />
      </g>
      <g className="animate-float">
        <path d="M282 40c-12 0-21 9-21 20 0 15 21 33 21 33s21-18 21-33c0-11-9-20-21-20Z" fill="#FFC940" />
        <path d="m276 60 4 4 8-8" stroke="#0d1f3d" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* school bus */}
      <g transform="translate(36 262)">
        <rect x="0" y="0" width="70" height="30" rx="7" fill="#FFC940" />
        <rect x="52" y="6" width="14" height="11" rx="2" fill="#EEF4FF" />
        <rect x="8" y="6" width="12" height="10" rx="2" fill="#EEF4FF" />
        <rect x="24" y="6" width="12" height="10" rx="2" fill="#EEF4FF" />
        <rect x="0" y="19" width="70" height="3" fill="#0d1f3d" opacity="0.25" />
        <circle cx="16" cy="31" r="6" fill="#0d1f3d" />
        <circle cx="54" cy="31" r="6" fill="#0d1f3d" />
        <circle cx="16" cy="31" r="2" fill="#c6d2e6" />
        <circle cx="54" cy="31" r="2" fill="#c6d2e6" />
      </g>

      {/* sparkles */}
      <g fill="#fff">
        <path d="M44 120l3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" opacity="0.8" />
        <path d="M444 132l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" opacity="0.7" />
        <path d="M176 70l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" opacity="0.6" />
      </g>
    </svg>
  );
}
