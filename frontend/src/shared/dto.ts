import type {
  IdentifierStatus,
  LocationInvalidReason,
  LocationValidationPurpose,
  SetupItemStatus,
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
  /** Whether first-time School Setup is finished. Visible to everyone who can see the school. */
  setupCompleted: boolean;
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

// ───────────────────────────────────────────────────────────── Setup overview (SCH-LOC-13)

export interface SetupItemDTO {
  key: string;
  label: string;
  description: string;
  status: SetupItemStatus;
  /** Share of the overall completion percentage (all weights add up to 100). */
  weight: number;
  /** Module that owns the item, e.g. `school-setup` or `academic-structure`. */
  module: string;
  /** Web route that fixes or opens the item, when one exists today. */
  href: string | null;
}

export interface SetupStatusDTO {
  schoolId: string;
  setupStatus: SchoolSetupDTO['status'];
  currentStep: number;
  /** Overall weighted completion across School Setup and the modules that follow it. */
  completionPercent: number;
  /** Completion of this module's own items only. */
  coreCompletionPercent: number;
  items: SetupItemDTO[];
  /** The most useful thing to do next (first pending item, then the first upcoming one). */
  nextStep: SetupItemDTO | null;
  summary: {
    schoolName: string;
    primaryLocation: { locationId: string; displayName: string; locationCode: string } | null;
    activeLocations: number;
    draftLocations: number;
    totalLocations: number;
  };
}

// ───────────────────────────────────────────────────────────── Master (downstream) contract (SCH-LOC-14)

export interface MasterSchoolContextDTO {
  schoolId: string;
  tenantId: string;
  displayName: string;
  shortName: string | null;
  defaults: { timezone: string; currency: string; locale: string };
  primaryLocationId: string | null;
  setupCompleted: boolean;
}

/** Deliberately small and frozen: downstream modules store `locationId`, never copy these fields. */
export interface MasterLocationDTO {
  locationId: string;
  schoolId: string;
  locationCode: string;
  displayName: string;
  locationType: LocationType;
  status: LocationStatus;
  isPrimary: boolean;
  city: string | null;
  state: string | null;
  country: string | null;
  effectiveDefaults: { timezone: string; currency: string; locale: string };
}

export interface LocationValidationResultDTO {
  locationId: string;
  valid: boolean;
  reason: LocationInvalidReason | null;
}

export interface LocationValidationDTO {
  purpose: LocationValidationPurpose;
  allValid: boolean;
  results: LocationValidationResultDTO[];
}
