import { Link } from 'react-router';
import { SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/sv/empty-state';

/**
 * Shown when the API answers 404. For a teacher this also covers a student outside their sections, so the page never says
 * which of the two it was: "Not found" is the whole answer.
 */
export function StudentNotFound({ backTo, backLabel }: { backTo: string; backLabel: string }) {
  return (
    <EmptyState
      illustration={<SearchX className="size-14 text-muted" aria-hidden="true" />}
      title="Not found"
      description="We could not find this page. The link may be wrong, or it may not be one you can open."
      action={
        <Button asChild variant="outline">
          <Link to={backTo}>{backLabel}</Link>
        </Button>
      }
    />
  );
}
