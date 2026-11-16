import type { TenantDTO, UserDTO } from '@shared';
import type { TenantDoc } from '../tenants/tenant.model';
import type { UserDoc } from './user.model';

export function toUserDTO(u: UserDoc): UserDTO {
  return {
    userId: u._id,
    tenantId: u.tenantId,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    status: u.status,
    personId: u.personId ?? null,
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    createdAt: new Date(u.createdAt).toISOString(),
  };
}

export function toTenantDTO(t: TenantDoc): TenantDTO {
  return { tenantId: t._id, name: t.name, slug: t.slug, status: t.status };
}
