import { CampusScene } from '@/components/illustrations/campus-scene';
import { useSession } from '@/lib/auth';
import { firstName } from '@/lib/utils';

/** Faculty and Staff see this until a School Admin finishes first-time setup. */
export function GettingSetUpPage() {
  const session = useSession();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-12 text-center">
      <CampusScene className="w-72" />
      <h1 className="mt-6 text-2xl font-extrabold">Your school is getting set up</h1>
      <p className="mt-2 text-[15px] text-muted">
        Hi {firstName(session.user.fullName)}! Your School Admin is still finishing the first-time setup. Once it’s done, you’ll see your school and campuses here.
      </p>
    </div>
  );
}
