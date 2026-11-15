import type { Role, TenantStatus, UserStatus } from './enums';
import type { Permission } from './permissions';

/** All IDs are permanent UUID strings. Labels are presentation only. */

export interface TenantDTO {
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
}

export interface UserDTO {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionDTO {
  user: UserDTO;
  tenant: TenantDTO;
  permissions: Permission[];
}

export interface PaginatedDTO<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AuditChangeDTO {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEventDTO {
  auditEventId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: { userId: string | null; role: Role | 'SYSTEM'; name?: string | null };
  changes: AuditChangeDTO[];
  metadata: Record<string, unknown>;
  occurredAt: string;
  requestId: string | null;
}
