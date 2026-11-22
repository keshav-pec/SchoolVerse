import { Link } from 'react-router';
import { LOCATION_TYPE_LABELS, type LocationDTO } from '@shared';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { PrimaryBadge } from '@/components/sv/primary-badge';
import { StatusPill } from '@/components/sv/status-pill';
import { cn } from '@/lib/utils';
import { LocationActions } from './location-actions';

const dash = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-IN'));

function SortHeader({ label, field, sort, onSort, className }: { label: string; field: string; sort: string; onSort: (sort: string) => void; className?: string }) {
  const asc = sort === field;
  const desc = sort === `-${field}`;
  const Icon = asc ? ArrowUp : desc ? ArrowDown : ChevronsUpDown;
  return (
    <th scope="col" aria-sort={asc ? 'ascending' : desc ? 'descending' : 'none'} className={cn('px-3 py-3 text-left text-xs font-bold tracking-wide text-muted uppercase', className)}>
      <button type="button" onClick={() => onSort(asc ? `-${field}` : field)} className="inline-flex items-center gap-1 rounded-md hover:text-ink">
        {label}
        <Icon className="size-3.5" aria-hidden="true" />
      </button>
    </th>
  );
}

interface Props {
  items: LocationDTO[];
  schoolId: string;
  sort: string;
  onSort: (sort: string) => void;
  currentPrimaryName?: string;
  dimmed?: boolean;
}

export function LocationTable({ items, schoolId, sort, onSort, currentPrimaryName, dimmed }: Props) {
  return (
    <>
      {/* Desktop table */}
      <div className={cn('hidden overflow-x-auto md:block', dimmed && 'opacity-60 transition-opacity')}>
        <table className="w-full min-w-[780px] text-sm">
          <caption className="sr-only">School locations</caption>
          <thead className="border-b border-line bg-canvas/70">
            <tr>
              <SortHeader label="Location" field="displayName" sort={sort} onSort={onSort} />
              <SortHeader label="Code" field="locationCode" sort={sort} onSort={onSort} />
              <SortHeader label="Type" field="locationType" sort={sort} onSort={onSort} />
              <SortHeader label="City" field="city" sort={sort} onSort={onSort} />
              <th scope="col" className="px-3 py-3 text-left text-xs font-bold tracking-wide text-muted uppercase">
                Primary
              </th>
              <SortHeader label="Status" field="status" sort={sort} onSort={onSort} />
              <th scope="col" className="px-3 py-3 text-right text-xs font-bold tracking-wide text-muted uppercase">
                Staff
              </th>
              <th scope="col" className="px-3 py-3 text-right text-xs font-bold tracking-wide text-muted uppercase">
                Students
              </th>
              <th scope="col" className="w-14 px-3 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((l) => (
              <tr key={l.locationId} className="hover:bg-canvas/60">
                <td className="px-3 py-3">
                  <Link to={`/school-setup/locations/${l.locationId}`} className="group flex items-center gap-3 rounded-lg">
                    <span className="min-w-0">
                      <span className="block max-w-[190px] truncate font-semibold text-ink group-hover:text-brand group-hover:underline">{l.displayName}</span>
                      {l.officialName && l.officialName !== l.displayName && <span className="block truncate text-xs text-muted">{l.officialName}</span>}
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-3 font-mono text-[13px] font-semibold tracking-wider">{l.locationCode}</td>
                <td className="px-3 py-3 whitespace-nowrap">{LOCATION_TYPE_LABELS[l.locationType]}</td>
                <td className="px-3 py-3">{l.address.city ?? '—'}</td>
                <td className="px-3 py-3">{l.isPrimary ? <PrimaryBadge /> : <span className="text-muted" aria-label="Not primary">—</span>}</td>
                <td className="px-3 py-3">
                  <StatusPill status={l.status} />
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{dash(l.staffCount)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{dash(l.studentCount)}</td>
                <td className="px-2 py-2 text-right">
                  <LocationActions location={l} schoolId={schoolId} currentPrimaryName={currentPrimaryName} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: stacked cards */}
      <ul className={cn('divide-y divide-line md:hidden', dimmed && 'opacity-60')} aria-label="School locations">
        {items.map((l) => (
          <li key={l.locationId} className="flex items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              <Link to={`/school-setup/locations/${l.locationId}`} className="block truncate font-semibold text-ink hover:text-brand">
                {l.displayName}
              </Link>
              <p className="mt-0.5 text-xs text-muted">
                <span className="font-mono font-semibold">{l.locationCode}</span> · {LOCATION_TYPE_LABELS[l.locationType]}
                {l.address.city ? ` · ${l.address.city}` : ''}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusPill status={l.status} />
                {l.isPrimary && <PrimaryBadge />}
              </div>
              <p className="mt-2 text-xs text-muted">
                Staff {dash(l.staffCount)} · Students {dash(l.studentCount)}
              </p>
            </div>
            <LocationActions location={l} schoolId={schoolId} currentPrimaryName={currentPrimaryName} />
          </li>
        ))}
      </ul>
    </>
  );
}
