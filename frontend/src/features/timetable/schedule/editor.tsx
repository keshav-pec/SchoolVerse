import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, TriangleAlert } from 'lucide-react';
import { RULE_LABELS, type AlternativeDTO, type RuleCode, type TimetableIssueDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { Modal } from '@/components/sv/modal';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { TT } from '../api';
import { calls, newRequestId } from './api';

/**
 * How every change is made on the schedule: send it, show Saving then Saved, keep a "Not saved yet" cell if the network fails (Try Again
 * sends the same request id, so nothing doubles), turn a clash into "Why Not Here?", ask before touching a fixed period, refresh a stale
 * cell, and remember the change so Undo can take it back.
 */

export interface RunOptions {
  requestId: string;
  confirmUnlock?: boolean;
  override?: { rule: RuleCode; reason: string };
}

interface Saved {
  changeSetId: string | null;
  label?: string;
  message?: string;
}

export interface ClashInfo {
  title: string;
  message: string;
  blockers: TimetableIssueDTO[];
  alternatives: AlternativeDTO[];
  /** Left out when there is nothing to retry (a swap check). Then no "Allow Anyway" is offered. */
  retry?: (override: { rule: RuleCode; reason: string }) => Promise<unknown>;
  apply?: (alt: AlternativeDTO) => Promise<unknown> | void;
}

interface UnlockInfo {
  message: string;
  confirm: () => Promise<unknown>;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface EditorValue {
  versionId: string;
  status: SaveStatus;
  failed: { label: string; retry: () => void } | null;
  canUndo: boolean;
  undoLast: () => Promise<void>;
  /** Runs a change. Resolves to the answer, or `null` when it was not saved (a clash, a lock, a stale cell, no network). */
  exec: <R extends Saved>(label: string, run: (o: RunOptions) => Promise<R>, opts?: { apply?: (alt: AlternativeDTO) => Promise<unknown> | void; quiet?: boolean }) => Promise<R | null>;
  showClash: (info: ClashInfo) => void;
}

const Ctx = createContext<EditorValue | null>(null);
export const useEditor = (): EditorValue => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useEditor needs <EditorProvider>');
  return value;
};

const isNetwork = (err: unknown) => err instanceof ApiError && (err.code === 'NETWORK_ERROR' || err.status === 0);

export function EditorProvider({ versionId, children }: { versionId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [failed, setFailed] = useState<EditorValue['failed']>(null);
  const [clash, setClash] = useState<ClashInfo | null>(null);
  const [unlock, setUnlock] = useState<UnlockInfo | null>(null);
  const [undo, setUndo] = useState<{ changeSetId: string; label: string }[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: TT }), [qc]);

  const undoById = useCallback(
    async (changeSetId: string) => {
      setStatus('saving');
      try {
        const r = await calls.undo(changeSetId);
        setUndo((s) => s.filter((x) => x.changeSetId !== changeSetId));
        setStatus('saved');
        toast.success(r.label);
        await refresh();
      } catch (err) {
        setStatus('idle');
        toast.error(messageFor(err));
      }
    },
    [refresh],
  );

  const exec = useCallback(
    <R extends Saved>(label: string, run: (o: RunOptions) => Promise<R>, opts: { apply?: (alt: AlternativeDTO) => Promise<unknown> | void; quiet?: boolean } = {}): Promise<R | null> => {
      const requestId = newRequestId();
      const attempt = async (extra: Omit<RunOptions, 'requestId'>): Promise<R | null> => {
        setStatus('saving');
        try {
          const result = await run({ requestId, ...extra });
          setFailed(null);
          setStatus('saved');
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setStatus('idle'), 3000);
          const text = result.label ?? result.message ?? label;
          if (result.changeSetId) {
            const id = result.changeSetId;
            setUndo((s) => [...s, { changeSetId: id, label: text }].slice(-20));
            if (!opts.quiet) toast.success(text, { action: { label: 'Undo', onClick: () => void undoById(id) } });
          } else if (!opts.quiet) toast.success(text);
          await refresh();
          return result;
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          const d = (err.details ?? {}) as { blockers?: TimetableIssueDTO[]; alternatives?: AlternativeDTO[] };
          if (err.code === 'TIMETABLE_CLASH') {
            setStatus('idle');
            setClash({ title: label, message: err.message, blockers: d.blockers ?? [], alternatives: d.alternatives ?? [], retry: (override) => attempt({ ...extra, override }), apply: opts.apply });
          } else if (err.code === 'ENTRY_FIXED') {
            setStatus('idle');
            setUnlock({ message: err.message, confirm: () => attempt({ ...extra, confirmUnlock: true }) });
          } else if (err.code === 'STALE_TIMETABLE') {
            setStatus('idle');
            await refresh();
            toast.info('Someone just changed this period. We refreshed it.');
          } else if (isNetwork(err)) {
            setStatus('failed');
            setFailed({ label, retry: () => void attempt(extra) });
          } else {
            setStatus('idle');
            toast.error(messageFor(err));
          }
          return null;
        }
      };
      return attempt({});
    },
    [refresh, undoById],
  );

  const value = useMemo<EditorValue>(
    () => ({
      versionId,
      status,
      failed,
      canUndo: undo.length > 0,
      undoLast: async () => {
        const last = undo[undo.length - 1];
        if (last) await undoById(last.changeSetId);
      },
      exec,
      showClash: setClash,
    }),
    [versionId, status, failed, undo, exec, undoById],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <WhyNotHere info={clash} onClose={() => setClash(null)} />
      <ConfirmDialog
        open={unlock !== null}
        onOpenChange={(open) => !open && setUnlock(null)}
        title="Unlock this fixed period first?"
        description={unlock?.message ?? ''}
        confirmLabel="Unlock And Continue"
        loadingLabel="Saving…"
        icon={<Lock className="size-5" />}
        onConfirm={async () => {
          await unlock?.confirm();
        }}
      />
    </Ctx.Provider>
  );
}

/** Saving… / Saved / Not saved yet, with Try Again. */
export function SaveIndicator() {
  const { status, failed } = useEditor();
  return (
    <span className="text-sm font-semibold" role="status" aria-live="polite">
      {status === 'saving' && <span className="text-muted">Saving…</span>}
      {status === 'saved' && <span className="text-success">Saved</span>}
      {status === 'failed' && failed && (
        <span className="flex items-center gap-2 text-danger">
          Not saved yet
          <Button size="sm" variant="outline" onClick={failed.retry}>
            Try Again
          </Button>
        </span>
      )}
    </span>
  );
}

function WhyNotHere({ info, onClose }: { info: ClashInfo | null; onClose: () => void }) {
  const { can } = useAuth();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const rules = [...new Set(info?.blockers.map((b) => b.rule) ?? [])];
  const overridable = !!info && !!info.retry && info.blockers.length > 0 && info.blockers.every((b) => b.overridable) && rules.length === 1 && can('timetable:conflict:override');

  const run = async (fn: () => Promise<unknown> | void) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setReason('');
    }
  };

  return (
    <Modal
      open={info !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Why Not Here?"
      description={info?.message}
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      {info && (
        <div className="space-y-4">
          <ul className="space-y-2" aria-label="Reasons">
            {info.blockers.map((b, i) => (
              <li key={`${b.rule}-${i}`} className="flex gap-2 rounded-xl border border-danger/25 bg-danger-soft/50 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <span>
                  <span className="font-semibold">{RULE_LABELS[b.rule]}.</span> {b.message}
                </span>
              </li>
            ))}
          </ul>
          {info.alternatives.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">Better options</p>
              <div className="flex flex-wrap gap-2">
                {info.alternatives.map((alt, i) => (
                  <Button
                    key={`${alt.kind}-${i}`}
                    variant="secondary"
                    size="sm"
                    disabled={busy || !info.apply}
                    onClick={() =>
                      void run(async () => {
                        onClose();
                        await info.apply?.(alt);
                      })
                    }
                  >
                    {alt.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {overridable && (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <p className="text-sm font-semibold">Allow it anyway</p>
              <p className="text-[13px] text-muted">This is a soft rule: “{RULE_LABELS[rules[0]!]}”. Write why you are allowing it. It is saved with your name.</p>
              <Textarea aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              <Button
                variant="outline"
                size="sm"
                disabled={reason.trim().length < 3 || busy}
                onClick={() =>
                  void run(async () => {
                    onClose();
                    await info.retry?.({ rule: rules[0]!, reason: reason.trim() });
                  })
                }
              >
                Allow Anyway
              </Button>
            </div>
          )}
          {!overridable && info.blockers.some((b) => b.overridable) && <Alert tone="info">Only someone with permission to override can allow this. Ask your School Admin.</Alert>}
        </div>
      )}
    </Modal>
  );
}
