import { Link } from 'react-router';
import { LostPlanet } from '@/components/illustrations/lost-planet';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <LostPlanet className="w-64" />
        <p className="mt-2 text-[11px] font-bold tracking-[0.18em] text-brand uppercase">Error 404</p>
        <h1 className="mt-2 text-[28px] font-extrabold">Lost in the SchoolVerse 🪐</h1>
        <p className="mt-2 text-[15px] text-muted">The page you’re looking for drifted out of orbit. Let’s get you back to familiar ground.</p>
        <Button asChild className="mt-6">
          <Link to="/">Take me home</Link>
        </Button>
      </div>
    </div>
  );
}
