import { ROLE_LABELS, type Role } from '@shared';
import { BookOpen, Crown, HeartHandshake, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const META = {
  SCHOOL_ADMIN: { tone: 'brand', Icon: Crown },
  FACULTY: { tone: 'lavender', Icon: BookOpen },
  STAFF: { tone: 'mint', Icon: Wrench },
  PARENT: { tone: 'coral', Icon: HeartHandshake },
} as const;

export function RoleBadge({ role }: { role: Role }) {
  const { tone, Icon } = META[role];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {ROLE_LABELS[role]}
    </Badge>
  );
}
