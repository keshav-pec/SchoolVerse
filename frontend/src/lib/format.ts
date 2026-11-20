import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { LocationAddressDTO } from '@shared';

/** `+919876543210` → `+91 98765 43210`. Falls back to the raw value. */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '—';
  return parsePhoneNumberFromString(value)?.formatInternational() ?? value;
}

/** `2026-11-15` (date-only, no timezone shift) → `15 Nov 2026`. */
export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatRelative(value: string, now = Date.now()): string {
  const diff = now - new Date(value).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDateTime(value);
}

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function formatAddress(address: LocationAddressDTO): string {
  const parts = [address.line1, address.line2, address.locality, address.city, [address.state, address.postalCode].filter(Boolean).join(' '), address.country ? countryName(address.country) : null];
  return parts.filter(Boolean).join(', ') || '—';
}

/** Human labels for audit field paths. */
export const FIELD_LABELS: Record<string, string> = {
  schoolCode: 'School code',
  legalName: 'Legal name',
  displayName: 'Name',
  shortName: 'Short name',
  primaryEmail: 'Primary email',
  primaryPhone: 'Primary phone',
  alternatePhone: 'Alternate phone',
  websiteUrl: 'Website',
  defaultTimezone: 'Default time zone',
  defaultCurrency: 'Default currency',
  defaultLocale: 'Default locale',
  locationCode: 'Code',
  locationType: 'Type',
  officialName: 'Official name',
  openingDate: 'Opening date',
  timezoneOverride: 'Time zone',
  currencyOverride: 'Currency',
  localeOverride: 'Locale',
  email: 'Email',
  phone: 'Phone',
  latitude: 'Latitude',
  longitude: 'Longitude',
  notes: 'Notes',
  status: 'Status',
  isPrimary: 'Primary',
  'address.line1': 'Address line 1',
  'address.line2': 'Address line 2',
  'address.locality': 'Locality',
  'address.city': 'City',
  'address.district': 'District',
  'address.state': 'State',
  'address.postalCode': 'Postal code',
  'address.country': 'Country',
  identifierType: 'Type',
  identifierValue: 'Value',
  issuingAuthority: 'Issuing authority',
  issueDate: 'Issue date',
  expiryDate: 'Expiry date',
  documentUrl: 'Document',
  logoUrl: 'Logo',
  // Faculty & Staff (Module 3)
  employeeCode: 'Employee code',
  employeeCategory: 'Category',
  employmentType: 'Employment type',
  joiningDate: 'Joining date',
  confirmationDate: 'Confirmed on',
  departmentId: 'Department',
  designationId: 'Designation',
  reportingManagerId: 'Reports to',
  officialEmail: 'Official email',
  officialPhone: 'Official phone',
  legalFirstName: 'First name',
  legalMiddleName: 'Middle name',
  legalLastName: 'Last name',
  preferredName: 'Preferred name',
  dateOfBirth: 'Date of birth',
  personalEmail: 'Personal email',
  personalPhone: 'Personal phone',
  address: 'Address',
  emergencyContact: 'Emergency contact',
  exitDate: 'Exit date',
  exitReasonCategory: 'Exit reason',
  role: 'Role',
  bank: 'Bank details',
  governmentIds: 'Government IDs',
  locationId: 'Location',
  effectiveFrom: 'Starts',
  effectiveTo: 'Ends',
};

export function fieldLabel(field: string): string {
  if (field.startsWith('governmentIds.')) return `Government ID (${field.slice('governmentIds.'.length).replace(/_/g, ' ').toLowerCase()})`;
  return FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

const PHONE_FIELDS = new Set(['phone', 'alternatePhone', 'primaryPhone']);

/** Renders one side of an audit diff ("+91 98… → +91 99…"). */
export function formatAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'empty';
  // Personal and restricted values are never written to the audit trail; the trail only says that they changed.
  if (value === '[redacted]') return 'hidden';
  // Ids carry no meaning for a reader; a short prefix is enough to tell two apart.
  if (typeof value === 'string' && /Id$/.test(field)) return value.slice(0, 8);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (PHONE_FIELDS.has(field)) return formatPhone(value);
    if (/Date$/.test(field)) return formatDateOnly(value);
    if (field === 'address.country') return countryName(value);
    return value;
  }
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
