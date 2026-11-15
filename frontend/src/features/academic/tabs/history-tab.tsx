import { ActivityTimeline } from '@/features/locations/activity-timeline';

/** Everything that happened inside the session, newest first, with field-level changes. */
export function HistoryTab({ sessionId }: { sessionId: string }) {
  return <ActivityTimeline academicSessionId={sessionId} enabled />;
}
