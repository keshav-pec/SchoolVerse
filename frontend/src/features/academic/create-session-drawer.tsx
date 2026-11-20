import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, FilePlus2 } from 'lucide-react';
import type { AcademicSessionDTO, MasterLocationDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sessionCall, useAcademicMutation, useActiveLocations, useBoards, useRuleVersions } from './api';

const STEPS = ['Details', 'Locations & boards', 'Start'] as const;

interface LocationEntry {
  on: boolean;
  boardId: string;
  boardRuleVersionId: string;
  affiliationNumber: string;
}

function LocationBoardRow({ location, entry, onChange }: { location: MasterLocationDTO; entry: LocationEntry; onChange: (patch: Partial<LocationEntry>) => void }) {
  const boards = useBoards();
  const versions = useRuleVersions(entry.on ? entry.boardId : undefined);
  const published = (versions.data ?? []).filter((v) => v.status === 'PUBLISHED');

  // Pick the first published rule version when the board changes.
  useEffect(() => {
    if (entry.on && published.length > 0 && !published.some((v) => v.ruleVersionId === entry.boardRuleVersionId)) onChange({ boardRuleVersionId: published[0]!.ruleVersionId });
  }, [entry.on, entry.boardRuleVersionId, published, onChange]);

  return (
    <li className={cn('rounded-xl border p-4', entry.on ? 'border-brand/40 bg-brand-soft/40' : 'border-line')}>
      <label className="flex items-center gap-3 text-sm font-semibold">
        <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={entry.on} onChange={(e) => onChange({ on: e.target.checked })} />
        {location.displayName} <span className="font-normal text-muted">({location.locationCode})</span>
      </label>
      {entry.on && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ComboboxField
            label="Board"
            value={entry.boardId}
            onChange={(v) => onChange({ boardId: v, boardRuleVersionId: '' })}
            placeholder="Choose…"
            options={(boards.data ?? []).map((b) => ({ value: b.boardId, label: b.boardName }))}
            searchPlaceholder="Search boards…"
          />
          <ComboboxField
            label="Rule version"
            value={entry.boardRuleVersionId}
            onChange={(v) => onChange({ boardRuleVersionId: v })}
            hint={published.length === 0 && !versions.isLoading ? 'This board has no published rule version yet.' : undefined}
            placeholder="Choose…"
            options={published.map((v) => ({ value: v.ruleVersionId, label: v.name }))}
            searchPlaceholder="Search versions…"
          />
          <TextField containerClassName="sm:col-span-2" label="Affiliation number (optional)" value={entry.affiliationNumber} onChange={(e) => onChange({ affiliationNumber: e.target.value })} />
        </div>
      )}
    </li>
  );
}

/** Create session in three steps: details → locations and boards → blank or clone, then review. */
export function CreateSessionDrawer({ open, onOpenChange, sessions, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; sessions: AcademicSessionDTO[]; onCreated: (id: string) => void }) {
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState({ name: '', code: '', startDate: '', endDate: '' });
  const [entries, setEntries] = useState<Record<string, LocationEntry>>({});
  const [mode, setMode] = useState<'BLANK' | 'CLONE'>('BLANK');
  const [cloneId, setCloneId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const locations = useActiveLocations();
  const boards = useBoards();

  const create = useAcademicMutation(
    (_: void) =>
      mode === 'CLONE'
        ? sessionCall.clone(cloneId, details)
        : sessionCall.create({
            ...details,
            locations: Object.entries(entries)
              .filter(([, e]) => e.on)
              .map(([locationId, e]) => ({ locationId, boardId: e.boardId, boardRuleVersionId: e.boardRuleVersionId, affiliationNumber: e.affiliationNumber || null })),
          }),
    { quiet: true, success: (s) => `${s.name} was created as a draft.` },
  );

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setErrors({});
    setBanner(null);
  }, [open]);

  // Default every active location to the first board, switched off.
  const firstBoard = boards.data?.[0]?.boardId;
  const entryFor = (id: string): LocationEntry => entries[id] ?? { on: false, boardId: firstBoard ?? '', boardRuleVersionId: '', affiliationNumber: '' };
  const patchEntry = (id: string) => (patch: Partial<LocationEntry>) => setEntries((cur) => ({ ...cur, [id]: { ...(cur[id] ?? entryFor(id)), ...patch } }));

  const next = () => {
    if (step === 0) {
      const e: Record<string, string> = {};
      if (!details.name.trim()) e.name = 'Session name is required.';
      if (!details.code.trim()) e.code = 'Session code is required.';
      if (!details.startDate) e.startDate = 'Start date is required.';
      if (!details.endDate) e.endDate = 'End date is required.';
      else if (details.startDate && details.endDate <= details.startDate) e.endDate = 'The end date must be after the start date.';
      setErrors(e);
      if (Object.keys(e).length) return;
    }
    setStep((s) => s + 1);
  };

  const submit = async () => {
    setBanner(null);
    try {
      const session = await create.mutateAsync();
      onOpenChange(false);
      onCreated(session.academicSessionId);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0) {
        setErrors(err.fieldErrors);
        setStep(0);
      }
      setBanner(messageFor(err));
    }
  };

  const chosen = Object.entries(entries).filter(([, e]) => e.on);
  const canCreate = mode === 'CLONE' ? Boolean(cloneId) : true;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Create academic session" description={`Step ${step + 1} of 3 · ${STEPS[step]}`}>
        <ol className="flex gap-2 border-b border-line bg-canvas px-5 py-3 text-sm font-semibold sm:px-6" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center gap-1.5', i === step ? 'text-brand' : i < step ? 'text-ink' : 'text-muted')}>
              <span className={cn('grid size-6 place-items-center rounded-full text-xs', i === step ? 'bg-brand text-white' : 'bg-ink/8')}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
              <span className="hidden sm:inline">{label}</span>
              {i < STEPS.length - 1 && <span aria-hidden="true" className="mx-1 text-muted">›</span>}
            </li>
          ))}
        </ol>
        <DrawerBody className="space-y-4">
          {banner && <Alert tone="danger">{banner}</Alert>}

          {step === 0 && (
            <>
              <TextField label="Session name" required value={details.name} error={errors.name} placeholder="Academic Year 2026-27" onChange={(e) => setDetails({ ...details, name: e.target.value })} />
              <TextField label="Session code" required value={details.code} error={errors.code} placeholder="2026-27" hint="Short and unique. Letters, numbers and hyphens." onChange={(e) => setDetails({ ...details, code: e.target.value.toUpperCase() })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField type="date" label="Start date" required value={details.startDate} error={errors.startDate} onChange={(e) => setDetails({ ...details, startDate: e.target.value })} />
                <TextField type="date" label="End date" required value={details.endDate} error={errors.endDate} onChange={(e) => setDetails({ ...details, endDate: e.target.value })} />
              </div>
              <p className="text-[13px] text-muted">Dates are explicit. A session doesn’t have to run April to March.</p>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-sm text-muted">Choose the active locations that run this session and the board each follows.</p>
              {mode === 'CLONE' && <Alert tone="info">You chose to clone a session, so its locations and boards are copied. You can change them afterwards.</Alert>}
              {locations.isLoading ? (
                <Skeleton className="h-24" />
              ) : (locations.data ?? []).length === 0 ? (
                <Alert tone="warning">There are no active locations yet. Activate a location in School Setup first.</Alert>
              ) : (
                <ul className="space-y-3">
                  {(locations.data ?? []).map((l) => (
                    <LocationBoardRow key={l.locationId} location={l} entry={entryFor(l.locationId)} onChange={patchEntry(l.locationId)} />
                  ))}
                </ul>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold">How do you want to start?</legend>
                {([['BLANK', 'Start blank', 'Add classes, sections and subjects yourself.', FilePlus2], ['CLONE', 'Clone a previous session', 'Copy its classes, sections, subjects, rules and terms.', Copy]] as const).map(([value, title, hint, Icon]) => (
                  <label key={value} className={cn('flex cursor-pointer gap-3 rounded-xl border p-4', mode === value ? 'border-brand bg-brand-soft/50' : 'border-line')}>
                    <input type="radio" name="start" className="mt-1 accent-[var(--color-brand)]" checked={mode === value} onChange={() => setMode(value)} />
                    <span>
                      <span className="flex items-center gap-2 text-sm font-bold">
                        <Icon className="size-4" aria-hidden="true" /> {title}
                      </span>
                      <span className="mt-0.5 block text-[13px] text-muted">{hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {mode === 'CLONE' && (
                <ComboboxField
                  label="Session to clone"
                  value={cloneId}
                  onChange={setCloneId}
                  hint={sessions.length === 0 ? 'There is no earlier session to clone.' : undefined}
                  placeholder="Choose a session…"
                  options={sessions.map((s) => ({ value: s.academicSessionId, label: s.name, hint: s.code }))}
                  searchPlaceholder="Search sessions…"
                />
              )}
              <section aria-label="Review" className="rounded-xl border border-line p-4 text-sm">
                <h3 className="mb-2 font-bold">Review</h3>
                <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
                  <dt className="text-muted">Name</dt>
                  <dd className="font-semibold">{details.name} ({details.code})</dd>
                  <dt className="text-muted">Dates</dt>
                  <dd>{formatDateOnly(details.startDate)} to {formatDateOnly(details.endDate)}</dd>
                  <dt className="text-muted">Locations</dt>
                  <dd>
                    {mode === 'CLONE' ? 'Copied from the cloned session' : chosen.length === 0 ? 'None yet (you can add them later)' : chosen.map(([id, e]) => `${locations.data?.find((l) => l.locationId === id)?.displayName ?? id} · ${boards.data?.find((b) => b.boardId === e.boardId)?.boardCode ?? ''}`).join(', ')}
                  </dd>
                </dl>
              </section>
            </>
          )}
        </DrawerBody>
        <DrawerFooter>
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep(step - 1)} disabled={create.isPending}>
              <ArrowLeft /> Back
            </Button>
          )}
          {step < 2 ? (
            <Button onClick={next}>
              Next <ArrowRight />
            </Button>
          ) : (
            <Button onClick={submit} loading={create.isPending} loadingText="Creating…" disabled={!canCreate}>
              Create Session
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
