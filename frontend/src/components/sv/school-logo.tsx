import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { useSchoolBranding } from '@/features/school-profile/api';
import { cn } from '@/lib/utils';

/**
 * The school's own logo in a small rounded tile, for the sidebar and top bar of every portal. It shows a building icon until the
 * school uploads a logo, and again if the logo file can't be loaded (never a broken image).
 */
export function SchoolLogo({ schoolName, className, iconClassName }: { schoolName: string; className?: string; iconClassName?: string }) {
  const logoUrl = useSchoolBranding().data?.logoUrl ?? null;
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const shown = logoUrl && logoUrl !== brokenUrl ? logoUrl : null;
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg', shown ? 'bg-white' : 'bg-brand/30 text-brand-300', className)}>
      {shown ? (
        <img src={shown} alt={`${schoolName} logo`} className="size-full object-cover object-center" onError={() => setBrokenUrl(shown)} />
      ) : (
        <Building2 className={cn('size-[18px]', iconClassName)} />
      )}
    </span>
  );
}
