import type {
  IdentifierStatus,
  LocationStatus,
  LocationType,
  Role,
  SchoolStatus,
  SetupStatus,
  TenantStatus,
  UserStatus,
} from './enums';
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

export interface AuditPageDTO {
  items: AuditEventDTO[];
  /** Pass back as `cursor` to load older events; `null` when there are no more. */
  nextCursor: string | null;
}

// ───────────────────────────────────────────────────────────── School master

export interface SchoolSetupDTO {
  status: SetupStatus;
  currentStep: number;
  completedAt: string | null;
}

export interface SchoolDTO {
  schoolId: string;
  tenantId: string;
  schoolCode: string;
  legalName: string;
  displayName: string;
  shortName: string | null;
  logoUrl: string | null;
  primaryEmail: string;
  primaryPhone: string;
  alternatePhone: string | null;
  websiteUrl: string | null;
  defaultTimezone: string;
  defaultCurrency: string;
  defaultLocale: string;
  status: SchoolStatus;
  /** Present only for users who can view configuration (`school:view_config`). */
  setup?: SchoolSetupDTO;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolIdentifierDTO {
  identifierId: string;
  schoolId: string;
  identifierType: string;
  identifierValue: string;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  documentUrl: string | null;
  status: IdentifierStatus;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────────────────────────────────────── School locations

export interface LocationAddressDTO {
  line1: string | null;
  line2: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2, e.g. `IN`. */
  country: string;
}

/** Timezone / currency / locale after inheriting from the school. */
export interface EffectiveDefaultsDTO {
  timezone: string;
  currency: string;
  locale: string;
  inherited: { timezone: boolean; currency: boolean; locale: boolean };
}

export interface LocationDTO {
  locationId: string;
  schoolId: string;
  locationCode: string;
  displayName: string;
  officialName: string | null;
  locationType: LocationType;
  isPrimary: boolean;
  status: LocationStatus;
  openingDate: string | null;
  timezoneOverride: string | null;
  currencyOverride: string | null;
  localeOverride: string | null;
  effectiveDefaults: EffectiveDefaultsDTO;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  websiteUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  address: LocationAddressDTO;
  /** `null` until the Staff / Student modules exist (UI shows "—"). */
  staffCount: number | null;
  studentCount: number | null;
  /** Internal notes — only for users with `location:view_config`. */
  notes?: string | null;
  statusChangedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationDetailDTO extends LocationDTO {
  /** The code can no longer change because downstream records reference the location. */
  codeLocked: boolean;
  /** Only an unreferenced DRAFT can be deleted; everything else must be archived. */
  deletable: boolean;
}

export interface LocationFacetsDTO {
  cities: { city: string; count: number }[];
  statuses: Record<LocationStatus, number>;
  types: Record<LocationType, number>;
}

export interface LocationListDTO extends PaginatedDTO<LocationDTO> {
  /** Counts across every location the user can see (ignoring the active filters). */
  facets: LocationFacetsDTO;
}

export interface LocationCodeAvailabilityDTO {
  /** The normalised code that was checked (`null` when only a name was sent). */
  code: string | null;
  valid: boolean;
  available: boolean;
  message: string | null;
  /** A free code based on `name` (or on the checked code when it is taken). */
  suggestion: string | null;
}

/** One reason an archive is blocked (`LOCATION_HAS_DEPENDENCIES` → `details.dependencies`). */
export interface LocationDependencyDTO {
  key: string;
  label: string;
  count: number;
  message: string;
}
