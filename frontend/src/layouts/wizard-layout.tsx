import type { ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { Logo } from '@/components/sv/logo';
import { Button } from '@/components/ui/button';
import { useAuth, useSession } from '@/lib/auth';

/** Full-screen frame for the first-time setup wizard: no sidebar, just the route and the task at hand. */
export function WizardLayout({ progress, children }: { progress: ReactNode; children: ReactNode }) {
  const session = useSession();
  const { logout } = useAuth();
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-8">
          <Logo />
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted sm:inline">{session.tenant.name}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                window.location.replace('/login');
              }}
            >
              <LogOut /> Save &amp; exit
            </Button>
          </div>
        </div>
        <div className="mx-auto max-w-3xl px-4 pt-2 pb-5 sm:px-8">{progress}</div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
        {children}
      </main>
    </div>
  );
}
