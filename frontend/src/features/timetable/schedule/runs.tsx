import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, Sparkles, X } from 'lucide-react';
import type { CopyPreviousResultDTO, GenerationRunDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { InfoTip } from '@/components/ui/tooltip';
import { Modal } from '@/components/sv/modal';
import { TIPS } from '../help-copy';
import { calls, newRequestId } from './api';
import { useEditor } from './editor';

export type RunResult = { kind: 'draft'; run: GenerationRunDTO } | { kind: 'copy'; copy: CopyPreviousResultDTO };

/** "1,642 of 1,728 placed · 86 left · 0 clashes · 14 warnings", with Review Exceptions as the main button. */
export function RunResultCard({ result, onDismiss }: { result: RunResult; onDismiss: () => void }) {
  const summary = result.kind === 'draft' ? result.run.summary : result.copy.summary;
  const left = result.kind === 'draft' ? result.run.unresolved : [];
  const partial = result.kind === 'draft' && result.run.status === 'PARTIAL';
  return (
    <Card className="space-y-3 border-success/40 bg-success-soft/40 p-4 sm:p-5" aria-label="Result">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <CircleCheck className="mt-0.5 size-6 shrink-0 text-success" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-extrabold">{result.kind === 'draft' ? 'Smart Draft is done' : "Last year's timetable is copied"}</h2>
            <p className="text-sm font-semibold" data-testid="run-summary">
              {summary}
            </p>
            {partial && <p className="text-sm text-warning">It stopped early to keep the screen fast. Run it again to finish.</p>}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss result">
          <X />
        </Button>
      </div>
      {left.length > 0 && (
        <ul className="space-y-1 text-[13px] text-muted" aria-label="Not placed">
          {left.slice(0, 4).map((u) => (
            <li key={u.key}>
              <span className="font-semibold text-ink">{u.label}</span>: {u.message}
            </li>
          ))}
          {left.length > 4 && <li>and {left.length - 4} more</li>}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link to="/timetable/attention">Review Exceptions</Link>
        </Button>
      </div>
    </Card>
  );
}

/** Run Smart Draft again from the schedule. Fill Gaps Only is the safe default; Start Fresh asks first and says what is removed. */
export function SmartDraftAgain({ open, onClose, lessons, onResult }: { open: boolean; onClose: () => void; lessons: number; onResult: (run: GenerationRunDTO) => void }) {
  const { versionId, exec } = useEditor();
  const [mode, setMode] = useState<'FILL_GAPS' | 'START_FRESH'>('FILL_GAPS');
  const [confirm, setConfirm] = useState(false);
  const run = async () => {
    onClose();
    const done = await exec('Smart Draft', (o) => calls.smartDraft(versionId, { mode, requestId: o.requestId ?? newRequestId(), ...(mode === 'START_FRESH' ? { confirm: true } : {}) }));
    if (done) onResult(done);
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Run Smart Draft Again"
      description="It only places what is valid, and checks every lesson for clashes."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={mode === 'START_FRESH' && !confirm} onClick={() => void run()}>
            <Sparkles /> {mode === 'FILL_GAPS' ? 'Fill Gaps' : 'Start Fresh'}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-3">
        <legend className="sr-only">How to run</legend>
        <label className="flex gap-3 rounded-xl border border-line p-3 text-sm">
          <input type="radio" name="mode" className="mt-1" checked={mode === 'FILL_GAPS'} onChange={() => setMode('FILL_GAPS')} />
          <span>
            <span className="flex items-center gap-1.5 font-bold">
              Fill Gaps Only <InfoTip label="About Fill Gaps Only">{TIPS.fillGaps}</InfoTip>
            </span>
            <span className="text-muted">Keeps all {lessons} lessons and adds what is missing.</span>
          </span>
        </label>
        <label className="flex gap-3 rounded-xl border border-line p-3 text-sm">
          <input type="radio" name="mode" className="mt-1" checked={mode === 'START_FRESH'} onChange={() => setMode('START_FRESH')} />
          <span>
            <span className="flex items-center gap-1.5 font-bold">
              Start Fresh <InfoTip label="About Start Fresh">{TIPS.startFresh}</InfoTip>
            </span>
            <span className="text-muted">Removes every lesson that is not fixed, then builds again.</span>
          </span>
        </label>
        {mode === 'START_FRESH' && (
          <Alert tone="warning" title="This removes lessons">
            Up to {lessons} lessons, including the ones you placed by hand, are removed. Fixed periods stay. You can undo it right after.
            <label className="mt-2 flex items-center gap-2 font-semibold">
              <input type="checkbox" className="size-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />I understand. Start fresh.
            </label>
          </Alert>
        )}
      </fieldset>
    </Modal>
  );
}
