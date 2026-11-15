import { Crown } from 'lucide-react';
import { motion } from 'motion/react';
import { Badge } from '@/components/ui/badge';

/** Crown-pin badge for the Primary Location. Pops in with a small spring when it appears. */
export function PrimaryBadge({ className }: { className?: string }) {
  return (
    <motion.span initial={{ scale: 0.6, rotate: -8, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 16 }} className="inline-flex">
      <Badge tone="sun" className={className}>
        <Crown aria-hidden="true" />
        Primary
      </Badge>
    </motion.span>
  );
}
