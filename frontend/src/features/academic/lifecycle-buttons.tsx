import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Archive, Copy, Lock, Play, Send, Trash2 } from 'lucide-react';
import type { AcademicSessionDTO, SessionAction } from '@shared';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { useAuth } from '@/lib/auth';
import { sessionCall, useAcademicMutation, useSessions } from './api';

type Dialog = SessionAction | 'clone' | 'delete' | null;

/** What each move does, in plain words, before the admin confirms it. */
export function effectOf(action: SessionAction, name: string): string {
  switch (action) {
    case 'publish':
      return `Publishing validates ${name} and makes it ready to activate. You can still adjust a published plan until it becomes active.`;
    case 'activate':
      return `Activating makes ${name} the current academic session. Another active session has to be closed first.`;
    case 'close':
      return `Closing makes ${name} read-only. Everything stays viewable, but nothing in it can be changed. Plan any change in the next session instead.`;
    case 'archive':
      return `Archiving keeps ${name} for history only. It will no longer appear for Faculty and Staff.`;
  }
}

/**
 * Lifecycle buttons for a session. `only="publish"` renders just the Publish control (used on the Overview tab),
 * which is disabled while validation errors exist, with the reason next to it.
 */
export function LifecycleButtons({ session, validationErrors, only }: { session: AcademicSessionDTO; validationErrors: number; only?: 'publish' }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [clone, setClone] = useState({ name: '', code: '', startDate: '', endDate: '' });
  const sessions = useSessions(dialog === 'activate');
  const otherActive = (sessions.data ?? []).find((s) => s.status === 'ACTIVE' && s.academicSessionId !== session.academicSessionId);
  const id = session.academicSessionId;

  const run = useAcademicMutation((action: SessionAction) => sessionCall.action(id, action), { quiet: true, success: (_r, a) => ({ publish: 'Session published.', activate: `${session.name} is now the current session.`, close: 'Session closed. It is now read-only.', archive: 'Session archived.' })[a] });
  const doClone = useAcademicMutation((_: void) => sessionCall.clone(id, clone), { quiet: true, success: (s) => `${s.name} was created as a draft.` });
  const doDelete = useAcademicMutation((_: void) => sessionCall.remove(id), { quiet: true, success: 'Draft session deleted.' });

  if (!can('academic:publish') && !can('academic:manage')) return null;
  const blocked = validationErrors > 0;
  const publish = (
    <span className="inline-flex flex-col items-start gap-1">
      <Button onClick={() => setDialog('publish')} disabled={blocked || session.status !== 'DRAFT'}>
        <Send /> Publish
      </Button>
      {blocked && session.status === 'DRAFT' && (
        <span role="note" className="text-xs font-medium text-danger">
          Fix {validationErrors} validation error{validationErrors === 1 ? '' : 's'} to publish.
        </span>
      )}
    </span>
  );
  if (only === 'publish') {
    return (
      <>
        {session.status === 'DRAFT' && publish}
        <ConfirmDialog open={dialog === 'publish'} onOpenChange={(o) => !o && setDialog(null)} title="Publish this session?" description={effectOf('publish', session.name)} confirmLabel="Publish" loadingLabel="Publishing…" icon={<Send className="size-5" />} onConfirm={async () => void (await run.mutateAsync('publish'))} />
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-start gap-2">
        {session.status === 'DRAFT' && can('academic:publish') && publish}
        {session.status === 'PUBLISHED' && can('academic:publish') && (
          <Button onClick={() => setDialog('activate')}>
            <Play /> Activate
          </Button>
        )}
        {session.status === 'ACTIVE' && can('academic:publish') && (
          <Button variant="outline" onClick={() => setDialog('close')}>
            <Lock /> Close Session
          </Button>
        )}
        {session.status === 'CLOSED' && can('academic:publish') && (
          <Button variant="outline" onClick={() => setDialog('archive')}>
            <Archive /> Archive
          </Button>
        )}
        {can('academic:publish') && (
          <Button variant="outline" onClick={() => setDialog('clone')}>
            <Copy /> Clone
          </Button>
        )}
        {session.status === 'DRAFT' && can('academic:manage') && (
          <Button variant="ghost" onClick={() => setDialog('delete')} aria-label="Delete draft session">
            <Trash2 />
          </Button>
        )}
      </div>

      {(['publish', 'activate', 'close', 'archive'] as const).map((action) => (
        <ConfirmDialog
          key={action}
          open={dialog === action}
          onOpenChange={(o) => !o && setDialog(null)}
          title={{ publish: 'Publish this session?', activate: 'Activate this session?', close: 'Close this session?', archive: 'Archive this session?' }[action]}
          description={effectOf(action, session.name)}
          confirmLabel={{ publish: 'Publish', activate: 'Activate', close: 'Close session', archive: 'Archive' }[action]}
          loadingLabel="Working…"
          tone={action === 'close' || action === 'archive' ? 'danger' : 'default'}
          onConfirm={async () => void (await run.mutateAsync(action))}
        >
          {action === 'activate' && otherActive && (
            <p role="note" className="rounded-lg bg-warning-soft px-3 py-2 text-sm">
              <Link to={`/academics/sessions/${otherActive.academicSessionId}`} className="font-semibold text-brand underline" onClick={() => setDialog(null)}>
                {otherActive.name}
              </Link>{' '}
              is the active session. Close it first.
            </p>
          )}
        </ConfirmDialog>
      ))}

      <ConfirmDialog
        open={dialog === 'clone'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Clone this session"
        description={`Creates a new draft with the classes, sections, subjects, rules, programmes and terms of ${session.name}. Students, staff and fees are never copied.`}
        confirmLabel="Create draft"
        loadingLabel="Cloning…"
        icon={<Copy className="size-5" />}
        onConfirm={async () => {
          const created = await doClone.mutateAsync();
          navigate(`/academics/sessions/${created.academicSessionId}`);
        }}
      >
        <div className="grid gap-3">
          <TextField label="New session name" value={clone.name} onChange={(e) => setClone({ ...clone, name: e.target.value })} />
          <TextField label="Code" value={clone.code} onChange={(e) => setClone({ ...clone, code: e.target.value.toUpperCase() })} />
          <div className="grid grid-cols-2 gap-3">
            <TextField type="date" label="Start date" value={clone.startDate} onChange={(e) => setClone({ ...clone, startDate: e.target.value })} />
            <TextField type="date" label="End date" value={clone.endDate} onChange={(e) => setClone({ ...clone, endDate: e.target.value })} />
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        tone="danger"
        title="Delete this draft?"
        description={`Deletes ${session.name} and everything planned in it. Only drafts can be deleted.`}
        confirmLabel="Delete draft"
        loadingLabel="Deleting…"
        icon={<Trash2 className="size-5" />}
        onConfirm={async () => {
          await doDelete.mutateAsync();
          navigate('/academics');
        }}
      />
    </>
  );
}
