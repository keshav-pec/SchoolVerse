import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { LOCATION_TYPE_LABELS, type LocationDetailDTO } from '@shared';
import { Archive, ArrowLeft, Globe, History, Lock, Mail, MapPin, Phone, Users } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { CampusAvatar } from '@/components/sv/campus-avatar';
import { ErrorState } from '@/components/sv/error-state';
import { PrimaryBadge } from '@/components/sv/primary-badge';
import { StatusPill } from '@/components/sv/status-pill';
import { useAuth } from '@/lib/auth';
import { countryName, formatAddress, formatDateOnly, formatDateTime, formatPhone } from '@/lib/format';
import { localeLabel } from '@/lib/options';
import { useCurrentSchool } from '../school-profile/api';
import { ActivityTimeline } from './activity-timeline';
import { useLocation } from './api';
import { EditableSection } from './editable-section';
import { LocationActions } from './location-actions';
import { AddressFields, BasicsFields, ContactFields, DefaultsFields } from './location-form';

function DefinitionList({ children }: { children: ReactNode }) {
  return <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-[170px_1fr]">{children}</dl>;
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words text-ink">{children || <span className="text-muted">—</span>}</dd>
    </>
  );
}

function Inherited({ inherited }: { inherited: boolean }) {
  return inherited ? <Badge tone="neutral" className="ml-2 align-middle">Inherited from school</Badge> : <Badge tone="brand" className="ml-2 align-middle">Overridden</Badge>;
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading location" className="space-y-6">
      <div className="flex items-center gap-4">
        <Skeleton className="size-16 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <Skeleton className="h-11 w-full max-w-md" />
      <Skeleton className="h-64 w-full rounded-card" />
    </div>
  );
}

export function LocationDetailPage() {
  const { locationId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const school = useCurrentSchool();
  const q = useLocation(locationId);
  const [tab, setTab] = useState('overview');

  if (q.isLoading || school.isLoading) return <DetailSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (school.isError) return <ErrorState error={school.error} onRetry={() => void school.refetch()} />;
  const l = q.data as LocationDetailDTO | undefined;
  if (!l || !school.data) return <ErrorState error={null} onRetry={() => void q.refetch()} />;

  const archived = l.status === 'ARCHIVED';
  const showActivity = can('audit:view');
  const d = l.effectiveDefaults;

  return (
    <div>
      <Link to="/school-setup/locations" className="mb-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" /> All locations
      </Link>

      <header className="mb-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <CampusAvatar code={l.locationCode} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-[24px] leading-tight font-extrabold sm:text-[26px]">{l.displayName}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusPill status={l.status} />
              {l.isPrimary && <PrimaryBadge />}
              <Badge tone="neutral" className="font-mono">{l.locationCode}</Badge>
              <span className="text-sm text-muted">{LOCATION_TYPE_LABELS[l.locationType]}</span>
            </div>
          </div>
        </div>
        <LocationActions variant="buttons" location={l} schoolId={l.schoolId} deletable={l.deletable} onDiscarded={() => navigate('/school-setup/locations', { replace: true })} />
      </header>

      {archived && (
        <Alert tone="warning" className="mb-4" title="This location is archived">
          <span className="inline-flex items-center gap-1.5"><Archive className="size-4" aria-hidden="true" /> Archived locations are kept for history only and can’t be changed.</span>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Location sections">
          <TabsTrigger value="overview">
            <MapPin /> Overview
          </TabsTrigger>
          <TabsTrigger value="contact">
            <Phone /> Address &amp; Contact
          </TabsTrigger>
          {showActivity && (
            <TabsTrigger value="activity">
              <History /> Activity
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <EditableSection
            title="Basic details"
            location={l}
            readOnly={archived}
            fields={['displayName', 'locationCode', 'locationType', 'officialName', 'openingDate']}
            successMessage="Location details updated."
            editor={(form) => <BasicsFields form={form} schoolId={l.schoolId} location={l} canCheckCode={can('location:view_config')} />}
            view={
              <DefinitionList>
                <Item label="Location name">{l.displayName}</Item>
                <Item label="Location code">
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono tracking-wider">{l.locationCode}</span>
                    {l.codeLocked && (
                      <Tooltip content="This code is locked because other records already reference this location. The location ID never changes.">
                        <button type="button" className="grid size-6 place-items-center rounded-md text-muted hover:text-ink" aria-label="Code is locked. Why?">
                          <Lock className="size-4" />
                        </button>
                      </Tooltip>
                    )}
                  </span>
                </Item>
                <Item label="Type">{LOCATION_TYPE_LABELS[l.locationType]}</Item>
                <Item label="Official name">{l.officialName}</Item>
                <Item label="Opening date">{l.openingDate ? formatDateOnly(l.openingDate) : ''}</Item>
                <Item label="Created">{formatDateTime(l.createdAt)}</Item>
                {l.statusChangedAt && <Item label="Status changed">{formatDateTime(l.statusChangedAt)}</Item>}
              </DefinitionList>
            }
          />

          <EditableSection
            title="Operational defaults"
            location={l}
            school={school.data}
            readOnly={archived}
            fields={['timezoneOverride', 'currencyOverride', 'localeOverride']}
            successMessage="Operational defaults updated."
            editor={(form) => <DefaultsFields form={form} school={school.data!} />}
            view={
              <DefinitionList>
                <Item label="Time zone">
                  {d.timezone.replace(/_/g, ' ')}
                  <Inherited inherited={d.inherited.timezone} />
                </Item>
                <Item label="Currency">
                  {d.currency}
                  <Inherited inherited={d.inherited.currency} />
                </Item>
                <Item label="Language & region">
                  {localeLabel(d.locale)}
                  <Inherited inherited={d.inherited.locale} />
                </Item>
              </DefinitionList>
            }
          />

          <Card>
            <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
              <Users className="size-5 text-muted" aria-hidden="true" /> People
            </h2>
            <DefinitionList>
              <Item label="Staff">{l.staffCount === null ? '— (available with the Staff module)' : String(l.staffCount)}</Item>
              <Item label="Students">{l.studentCount === null ? '— (available with the Students module)' : String(l.studentCount)}</Item>
            </DefinitionList>
          </Card>
        </TabsContent>

        <TabsContent value="contact" className="space-y-6">
          <EditableSection
            title="Address"
            location={l}
            readOnly={archived}
            fields={['address', 'latitude', 'longitude']}
            successMessage="Address updated."
            editor={(form) => <AddressFields form={form} />}
            view={
              <DefinitionList>
                <Item label="Address">{l.address.line1 ? formatAddress(l.address) : ''}</Item>
                <Item label="Country">{countryName(l.address.country)}</Item>
                <Item label="Coordinates">{l.latitude !== null && l.longitude !== null ? `${l.latitude}, ${l.longitude}` : ''}</Item>
              </DefinitionList>
            }
          />
          <EditableSection
            title="Contact"
            location={l}
            readOnly={archived}
            fields={['phone', 'alternatePhone', 'email', 'websiteUrl', 'notes']}
            successMessage="Contact details updated."
            editor={(form) => <ContactFields form={form} showNotes={can('location:view_config')} />}
            view={
              <DefinitionList>
                <Item label="Phone">
                  {l.phone && (
                    <span className="inline-flex items-center gap-2">
                      <Phone className="size-4 text-muted" aria-hidden="true" /> {formatPhone(l.phone)}
                    </span>
                  )}
                </Item>
                <Item label="Alternate phone">{l.alternatePhone ? formatPhone(l.alternatePhone) : ''}</Item>
                <Item label="Email">
                  {l.email && (
                    <a href={`mailto:${l.email}`} className="inline-flex items-center gap-2 text-brand hover:underline">
                      <Mail className="size-4" aria-hidden="true" /> {l.email}
                    </a>
                  )}
                </Item>
                <Item label="Website">
                  {l.websiteUrl && (
                    <a href={l.websiteUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-2 text-brand hover:underline">
                      <Globe className="size-4" aria-hidden="true" /> {l.websiteUrl.replace(/^https?:\/\//, '')}
                    </a>
                  )}
                </Item>
                {can('location:view_config') && <Item label="Internal notes">{l.notes}</Item>}
              </DefinitionList>
            }
          />
        </TabsContent>

        {showActivity && (
          <TabsContent value="activity">
            <Card>
              <h2 className="mb-5 text-lg font-bold">Activity</h2>
              <ActivityTimeline entityType="school_location" entityId={l.locationId} enabled={tab === 'activity'} />
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
