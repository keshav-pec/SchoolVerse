import type { ReactNode } from 'react';
import type { Permission } from '@shared';
import { useAuth } from '@/lib/auth';

/**
 * Renders children only when the current user holds every listed permission.
 * Cosmetic only — the API enforces the same rules server-side.
 */
export function Can({ permission, children, fallback = null }: { permission: Permission | Permission[]; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useAuth();
  const required = Array.isArray(permission) ? permission : [permission];
  return <>{required.every(can) ? children : fallback}</>;
}
