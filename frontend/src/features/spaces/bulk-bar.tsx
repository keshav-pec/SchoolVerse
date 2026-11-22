import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SPACE_FEATURES, SPACE_STATUS_LABELS, SPACE_SUITABILITY_TAGS, SPACE_TARGET_STATUSES, type BulkEditResultDTO } from '@shared';
import { Armchair, CircleCheck, Replace, Sparkles, Tags, ToggleRight, X } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Modal } from '@/components/sv/modal';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { SP, useSpaceMutation, useSpaceTypes } from './api';
import { CheckGroup } from './space-controls';

type Kind = 'type' | 'capacity' | 'features' | 'tags' | 'status';

const TITLES: Record<Kind, string> = { type: 'Change type', capacity: 'Set seats', features: 'Add or remove features', tags: 'Add or remove “suitable for”', status: 'Set status' };
const CAPACITY_FIELDS = [
  { value: 'academicCapacity', label: 'Seats for classes' },
  { value: 'physicalCapacity', label: 'Physical capacity' },
  { value: 'examCapacity', label: 'Exam capacity' },
];
const ADD_REMOVE = [
  { value: 'add', label: 'Add these' },
  { value: 'remove', label: 'Remove these' },
];

/**
 * One change for many rooms. It first asks the server how many rooms would change and which would be skipped (nothing is saved
 * yet), and only then applies it. The result lists every skipped room with its reason.
 */
function BulkDialog({ kind, ids, onClose, onDone }: { kind: Kind; ids: string[]; onClose: () => void; onDone: () => void }) {
  const types = useSpaceTypes();
  const [typeId, setTypeId] = useState('');
  const [capField, setCapField] = useState('academicCapacity');
  const [capText, setCapText] = useState('');
  const [mode, setMode] = useState('add');
  const [features, setFeatures] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkEditResultDTO | null>(null);
  const apply = useSpaceMutation((body: object) => api.patch<BulkEditResultDTO>('/physical-spaces/bulk', body), { quiet: true });

  const capacity = /^\d+$/.test(capText.trim()) && Number(capText) > 0 ? Number(capText) : null;
  const changes: Record<string, unknown> | null =
    kind === 'type'
      ? typeId
        ? { spaceTypeId: typeId }
        : null
      : kind === 'capacity'
        ? capacity !== null
          ? { [capField]: capacity }
          : null
        : kind === 'features'
          ? features.length > 0
            ? { [mode === 'add' ? 'addFeatures' : 'removeFeatures']: features }
            : null
          : kind === 'tags'
            ? tags.length > 0
              ? { [mode === 'add' ? 'addTags' : 'removeTags']: tags }
              : null
            : status
              ? { status }
              : null;

  const key = JSON.stringify(changes);
  const preview = useQuery({
    queryKey: [...SP, 'bulk-preview', ids, key],
    queryFn: () => api.patch<BulkEditResultDTO>('/physical-spaces/bulk', { ids, changes, dryRun: true }),
    enabled: changes !== null && !result,
    retry: false,
  });

  const submit = async () => {
    setError(null);
    try {
      if (!changes) throw new FormProblem('Choose what to change first.');
      setResult(await apply.mutateAsync({ ids, changes, ...(kind === 'type' ? { confirm: true } : {}) }));
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const typeOptions = (types.data ?? []).filter((t) => t.status === 'ACTIVE').map((t) => ({ value: t.spaceTypeId, label: t.name }));

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) {
          if (result) onDone();
          else onClose();
        }
      }}
      title={`${TITLES[kind]} for ${ids.length} room${ids.length === 1 ? '' : 's'}`}
      footer={
        result ? (
          <Button onClick={onDone}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} loading={apply.isPending} loadingText="Saving…" disabled={!changes || preview.isLoading || (preview.data?.done.length ?? 1) === 0}>
              {preview.data ? `Change ${preview.data.done.length} Room${preview.data.done.length === 1 ? '' : 's'}` : 'Apply Change'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3" data-testid="bulk-result">
          <Alert tone={result.done.length > 0 ? 'success' : 'warning'}>{result.message}</Alert>
          {result.skipped.length > 0 && (
            <section aria-label="Rooms that were skipped">
              <h3 className="mb-1.5 text-sm font-bold">Skipped rooms</h3>
              <ul className="space-y-1 text-sm">
                {result.skipped.map((s) => (
                  <li key={s.spaceId}>
                    <b>{s.spaceCode ?? 'Room'}</b>: {s.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {kind === 'type' && <ComboboxField label="New type" required value={typeId} onChange={setTypeId} options={typeOptions} placeholder="Choose…" searchPlaceholder="Search types…" hint="Rooms take this type’s settings. Indoor rooms cannot become outdoor spaces." />}
          {kind === 'capacity' && (
            <>
              <ComboboxField label="Which number" value={capField} onChange={setCapField} options={CAPACITY_FIELDS} searchPlaceholder="Search…" />
              <TextField label="Number" required inputMode="numeric" value={capText} onChange={(e) => setCapText(e.target.value)} hint="A whole number above zero. Example: 40." />
            </>
          )}
          {kind === 'features' && (
            <>
              <ComboboxField label="What to do" value={mode} onChange={setMode} options={ADD_REMOVE} searchPlaceholder="Search…" />
              <CheckGroup legend="Features" options={SPACE_FEATURES} selected={features} onChange={setFeatures} />
            </>
          )}
          {kind === 'tags' && (
            <>
              <ComboboxField label="What to do" value={mode} onChange={setMode} options={ADD_REMOVE} searchPlaceholder="Search…" />
              <CheckGroup legend="Suitable for" options={SPACE_SUITABILITY_TAGS} selected={tags} onChange={setTags} />
            </>
          )}
          {kind === 'status' && <ComboboxField label="New status" required value={status} onChange={setStatus} options={SPACE_TARGET_STATUSES.map((s) => ({ value: s, label: SPACE_STATUS_LABELS[s] }))} placeholder="Choose…" searchPlaceholder="Search…" />}

          {changes && (
            <section aria-label="What will happen" aria-live="polite" data-testid="bulk-preview">
              {preview.isLoading ? (
                <Skeleton className="h-10" />
              ) : preview.isError ? (
                <Alert tone="danger">{messageFor(preview.error)}</Alert>
              ) : preview.data ? (
                <div className="space-y-1.5">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <CircleCheck className="size-4 text-success" aria-hidden="true" /> {preview.data.done.length} room{preview.data.done.length === 1 ? '' : 's'} will change
                    {preview.data.skipped.length > 0 ? ` · ${preview.data.skipped.length} will be skipped` : ''}
                  </p>
                  {preview.data.skipped.length > 0 && (
                    <ul className="space-y-0.5 text-[13px] text-muted">
                      {preview.data.skipped.map((s) => (
                        <li key={s.spaceId}>
                          {s.spaceCode ?? 'Room'}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

/** Appears when one or more rooms are ticked. */
export function BulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const [kind, setKind] = useState<Kind | null>(null);
  if (ids.length === 0) return null;
  const actions: { kind: Kind; label: string; Icon: typeof Replace }[] = [
    { kind: 'type', label: 'Change Type', Icon: Replace },
    { kind: 'capacity', label: 'Set Capacity', Icon: Armchair },
    { kind: 'features', label: 'Features', Icon: Sparkles },
    { kind: 'tags', label: 'Suitable For', Icon: Tags },
    { kind: 'status', label: 'Set Status', Icon: ToggleRight },
  ];
  return (
    <>
      <div role="region" aria-label="Change many rooms" className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-white px-3 py-2 shadow-card">
        <p className="mr-1 text-sm font-semibold" data-testid="bulk-count">
          {ids.length} room{ids.length === 1 ? '' : 's'} selected
        </p>
        {actions.map((a) => (
          <Button key={a.kind} size="sm" variant="outline" onClick={() => setKind(a.kind)}>
            <a.Icon /> {a.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
          <X /> Clear
        </Button>
      </div>
      {kind && (
        <BulkDialog
          kind={kind}
          ids={ids}
          onClose={() => setKind(null)}
          onDone={() => {
            setKind(null);
            onClear();
          }}
        />
      )}
    </>
  );
}
