import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CopyPreviewDTO, CopyResultDTO } from '@shared';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Modal } from '@/components/sv/modal';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { useActiveLocations } from '../academic/api';
import { SP, useSpaceMutation } from './api';

const line = (label: string, c: { create: number; existing: number }) => `${label}: ${c.create} new${c.existing > 0 ? `, ${c.existing} already there` : ''}`;

/** Copies the buildings, floors and room patterns of another campus. It never copies which section sits in which room. */
export function CopyStructureDialog({ locationId, locationName, onClose }: { locationId: string; locationName: string; onClose: () => void }) {
  const locations = useActiveLocations();
  const others = (locations.data ?? []).filter((l) => l.status === 'ACTIVE' && l.locationId !== locationId);
  const [fromId, setFromId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: [...SP, 'copy-preview', locationId, fromId],
    queryFn: () => api.post<CopyPreviewDTO>(`/locations/${locationId}/copy-structure/preview`, { fromLocationId: fromId }),
    enabled: !!fromId,
    retry: false,
  });
  const copy = useSpaceMutation((body: object) => api.post<CopyResultDTO>(`/locations/${locationId}/copy-structure`, body), { quiet: true });
  const p = preview.data;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Copy from another location"
      description={`Copies the building layout into ${locationName}.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!p}
            loading={copy.isPending}
            loadingText="Copying…"
            onClick={async () => {
              setError(null);
              try {
                if (!fromId) throw new FormProblem('Choose the campus to copy from.');
                const r = await copy.mutateAsync({ fromLocationId: fromId });
                toast.success(`Copied ${r.rooms.create} rooms, ${r.floors.create} floors and ${r.buildings.create} buildings.`);
                onClose();
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            <Copy /> Copy Structure
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ComboboxField
          label="Copy from"
          required
          value={fromId}
          onChange={setFromId}
          options={others.map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))}
          placeholder={others.length === 0 ? 'No other campus' : 'Choose…'}
          searchPlaceholder="Search campuses…"
          hint={others.length === 0 ? 'Add another campus in School Setup first.' : undefined}
        />
        {preview.isLoading && <Skeleton className="h-16" />}
        {preview.isError && <Alert tone="danger">{messageFor(preview.error)}</Alert>}
        {p && (
          <section aria-label="What will be copied" className="space-y-2" data-testid="copy-preview">
            <ul className="space-y-1 text-sm">
              <li>{line('Buildings', p.buildings)}</li>
              <li>{line('Floors', p.floors)}</li>
              <li>{line('Rooms', p.rooms)}</li>
            </ul>
            {p.clashes.length > 0 && (
              <Alert tone="warning" title="These rooms are not copied">
                <ul className="list-disc pl-5">
                  {p.clashes.map((c) => (
                    <li key={c.spaceCode}>
                      {c.spaceCode}: {c.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <p className="text-[13px] text-muted">{p.note}</p>
          </section>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
