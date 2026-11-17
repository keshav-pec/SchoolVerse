import { useState } from 'react';
import {
  EXPORT_PURPOSES,
  EXPORT_PURPOSE_LABELS,
  type ExportPurpose,
  type ExportResultDTO,
} from '@shared';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { openSignedLink, type EmployeeListParams } from './api';

/** Export: the purpose decides the columns. Restricted details (date of birth, IDs, bank) can never be exported. */
export function ExportDialog({
  open,
  onOpenChange,
  filters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: EmployeeListParams;
}) {
  const [purpose, setPurpose] = useState<ExportPurpose>('DIRECTORY');
  const { page: _page, pageSize: _pageSize, ...rest } = filters;
  const active = Object.entries(rest).filter(([, v]) => v);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Download className="size-5" />}
      title="Export staff"
      description="Choose what the file is for. It uses the filters you have set on this page."
      confirmLabel="Export CSV"
      loadingLabel="Preparing the file…"
      onConfirm={async () => {
        const result = await api.post<ExportResultDTO>('/employees/exports', {
          purpose,
          filters: Object.fromEntries(active),
        });
        openSignedLink(result.url);
        toast.success(
          `${result.rowCount} ${result.rowCount === 1 ? 'person' : 'people'} exported. The link works for 15 minutes.`,
        );
      }}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Purpose</legend>
        {EXPORT_PURPOSES.map((p) => (
          <label
            key={p}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm',
              purpose === p ? 'border-brand bg-brand-soft' : 'border-line hover:bg-canvas',
            )}
          >
            <input
              type="radio"
              name="purpose"
              value={p}
              checked={purpose === p}
              onChange={() => setPurpose(p)}
              className="mt-1 accent-[var(--color-brand)]"
            />
            <span>
              <span className="block font-semibold">
                {p === 'DIRECTORY' ? 'Directory' : 'Employment'}
              </span>
              <span className="text-muted">{EXPORT_PURPOSE_LABELS[p]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Alert tone="info" className="mt-3">
        {active.length > 0
          ? `${active.length} filter${active.length === 1 ? ' is' : 's are'} applied.`
          : 'No filters: everyone who is currently on staff.'}{' '}
        Dates of birth, IDs and bank details are never included.
      </Alert>
    </ConfirmDialog>
  );
}
