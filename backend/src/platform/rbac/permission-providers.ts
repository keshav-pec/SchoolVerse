import type { Permission, Role } from '@shared';
import { permissionsFor } from '@shared';

/**
 * Extra permissions that are not part of a role. A module that gives people permissions on top of their role (Finance job
 * bundles) registers a provider here. The permission list is built from the database on EVERY request and on `/me`, so taking a
 * bundle away works on the very next request.
 */
export interface PermissionSubject {
  _id: string;
  tenantId: string;
  role: Role;
}
export type PermissionProvider = (user: PermissionSubject) => Promise<readonly Permission[]>;

const providers = new Map<string, PermissionProvider>();

export function registerPermissionProvider(key: string, provider: PermissionProvider) {
  providers.set(key, provider);
}

export async function effectivePermissions(user: PermissionSubject): Promise<Permission[]> {
  const extra = await Promise.all([...providers.values()].map((p) => p(user)));
  return [...new Set([...permissionsFor(user.role), ...extra.flat()])];
}
