import { Link } from 'react-router';
import { LockedDoor } from '@/components/illustrations/locked-door';
import { Button } from '@/components/ui/button';

export function ForbiddenPage({ message }: { message?: string }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-12 text-center">
      <LockedDoor className="w-56" />
      <h1 className="mt-4 text-2xl font-extrabold">This area is for school administrators</h1>
      <p className="mt-2 text-[15px] text-muted">{message ?? 'Your role doesn’t include access to this page. If you think that’s a mistake, ask your School Admin.'}</p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/">Back to home</Link>
      </Button>
    </div>
  );
}
