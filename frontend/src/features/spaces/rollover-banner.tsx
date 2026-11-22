import { Link } from 'react-router';
import type { AcademicSessionDTO } from '@shared';
import { Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStudentContext } from '../students/context';
import { useAssignments } from './allocation-api';

const writable = (s: AcademicSessionDTO | undefined) => !!s && s.status !== 'CLOSED' && s.status !== 'ARCHIVED';

/** The year after `session`: the one cloned from it, else the next one by start date. */
export function nextSessionOf(sessions: readonly AcademicSessionDTO[], session: AcademicSessionDTO | undefined): AcademicSessionDTO | undefined {
  if (!session) return undefined;
  return sessions.find((s) => s.previousSessionId === session.academicSessionId) ?? [...sessions].filter((s) => s.startDate > session.startDate).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
}

export function previousSessionOf(sessions: readonly AcademicSessionDTO[], session: AcademicSessionDTO | undefined): AcademicSessionDTO | undefined {
  if (!session) return undefined;
  return sessions.find((s) => s.academicSessionId === session.previousSessionId) ?? [...sessions].filter((s) => s.startDate < session.startDate).sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
}

/**
 * "2027-28 has no Home Classrooms yet. Carry forward from 2026-27?" Shown on Classroom Allocation when one of two years next to each
 * other has rooms and the later one has none.
 */
export function RolloverBanner() {
  const ctx = useStudentContext();
  const next = nextSessionOf(ctx.sessions, ctx.session);
  const prev = previousSessionOf(ctx.sessions, ctx.session);
  const count = (sessionId: string | undefined) => ({ academicSessionId: sessionId, locationId: ctx.locationId, pageSize: 1 });
  const here = useAssignments(count(ctx.sessionId), !!ctx.sessionId);
  const after = useAssignments(count(next?.academicSessionId), !!next && writable(next));
  const before = useAssignments(count(prev?.academicSessionId), !!prev && writable(ctx.session));
  if (!ctx.session || !here.data) return null;

  let pair: [AcademicSessionDTO, AcademicSessionDTO] | null = null;
  if (next && writable(next) && here.data.total > 0 && after.data?.total === 0) pair = [ctx.session, next];
  else if (prev && writable(ctx.session) && here.data.total === 0 && (before.data?.total ?? 0) > 0) pair = [prev, ctx.session];
  if (!pair) return null;
  const [from, to] = pair;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-brand/20 bg-brand-soft px-4 py-2.5 text-sm" data-testid="rollover-banner">
      <Repeat className="size-4 text-brand" aria-hidden="true" />
      <span className="flex-1">
        <b>{to.code}</b> has no Home Classrooms yet. Carry forward from {from.code}?
      </span>
      <Button asChild size="sm">
        <Link to={`/spaces/rollover?from=${from.academicSessionId}&to=${to.academicSessionId}`}>Carry Forward</Link>
      </Button>
    </div>
  );
}
