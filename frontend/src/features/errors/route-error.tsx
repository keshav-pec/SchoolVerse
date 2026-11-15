import { useRouteError } from 'react-router';
import { LostPlanet } from '@/components/illustrations/lost-planet';
import { Button } from '@/components/ui/button';

export function RouteError() {
  const error = useRouteError();
  if (import.meta.env.DEV) console.error(error);
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <LostPlanet className="w-56" />
        <h1 className="mt-4 text-2xl font-extrabold">Something went sideways</h1>
        <p className="mt-2 text-[15px] text-muted">An unexpected error happened. Reloading usually fixes it.</p>
        <Button className="mt-6" onClick={() => window.location.reload()}>
          Reload page
        </Button>
      </div>
    </div>
  );
}
