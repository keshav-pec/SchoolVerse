import { RefreshCw } from 'lucide-react';
import { LostPlanet } from '@/components/illustrations/lost-planet';
import { Button } from '@/components/ui/button';
import { ForbiddenPage } from '@/features/errors/forbidden-page';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Failed-load state with retry. 403 shows the access-denied page, 404 a friendly not-found. */
export function ErrorState({ error, onRetry, retrying }: { error: unknown; onRetry?: () => void; retrying?: boolean }) {
  if (error instanceof ApiError && error.status === 403) return <ForbiddenPage />;
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center py-12 text-center">
      <LostPlanet className="w-56" />
      <h2 className="mt-4 text-xl font-extrabold">{notFound ? 'We couldn’t find that' : 'We couldn’t load this'}</h2>
      <p className="mt-1.5 text-[15px] text-muted">{messageFor(error)}</p>
      {onRetry && !notFound && (
        <Button variant="outline" className="mt-6" onClick={onRetry} loading={retrying} loadingText="Retrying…">
          <RefreshCw /> Try Again
        </Button>
      )}
    </div>
  );
}
