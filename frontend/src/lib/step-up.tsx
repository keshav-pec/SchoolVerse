import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { STEP_UP_SECONDS, type StepUpDTO } from '@shared';
import { ShieldCheck } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/field';
import { api, ApiError } from './api';
import { messageFor } from './errors';

/** Thrown when the person closes the password dialog. Callers treat it as "never mind", not as a failure. */
export class StepUpCancelled extends Error {
  constructor() {
    super('Step-up cancelled');
    this.name = 'StepUpCancelled';
  }
}

export const isStepUpCancelled = (err: unknown): err is StepUpCancelled =>
  err instanceof StepUpCancelled;

interface StepUpValue {
  /**
   * Runs `fn`. If the server answers `STEP_UP_REQUIRED`, asks for the password once and runs `fn` again (once).
   * Restricted actions are checked on the server; this only makes the round trip pleasant.
   */
  withStepUp: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Makes sure a recent step-up exists before showing something that will need one (an edit form). */
  ensureStepUp: () => Promise<void>;
}

const StepUpContext = createContext<StepUpValue | null>(null);

/** A little shorter than the server's window, so the client never trusts a stamp that is about to lapse. */
const FRESH_MS = (STEP_UP_SECONDS - 20) * 1000;

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const waiting = useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null>(null);
  const lastAt = useRef(0);

  const prompt = useCallback((): Promise<void> => {
    if (waiting.current) return waiting.current.promise;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    waiting.current = { promise, resolve, reject };
    setPassword('');
    setError(null);
    setOpen(true);
    return promise;
  }, []);

  const finish = (result: 'done' | 'cancelled') => {
    const current = waiting.current;
    waiting.current = null;
    setOpen(false);
    if (!current) return;
    if (result === 'done') current.resolve();
    else current.reject(new StepUpCancelled());
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setError('Enter your password.');
    setPending(true);
    setError(null);
    try {
      await api.post<StepUpDTO>('/auth/step-up', { password });
      lastAt.current = Date.now();
      finish('done');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'INVALID_CREDENTIALS'
          ? 'That password is not right.'
          : messageFor(err),
      );
    } finally {
      setPending(false);
    }
  };

  const value = useMemo<StepUpValue>(
    () => ({
      withStepUp: async (fn) => {
        try {
          return await fn();
        } catch (err) {
          if (!(err instanceof ApiError && err.code === 'STEP_UP_REQUIRED')) throw err;
          await prompt();
          return fn();
        }
      },
      ensureStepUp: async () => {
        if (Date.now() - lastAt.current < FRESH_MS) return;
        await prompt();
      },
    }),
    [prompt],
  );

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <Primitive.Root open={open} onOpenChange={(next) => !next && !pending && finish('cancelled')}>
        <Primitive.Portal>
          <Primitive.Overlay className="fixed inset-0 z-[60] bg-navy/50 backdrop-blur-[2px]" />
          <Primitive.Content className="fixed top-1/2 left-1/2 z-[60] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-card border border-line bg-white p-6 shadow-pop outline-none">
            <form onSubmit={submit} noValidate>
              <div className="flex gap-4">
                <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
                  <ShieldCheck className="size-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <Primitive.Title className="text-lg font-extrabold text-ink">
                    Confirm your password
                  </Primitive.Title>
                  <Primitive.Description className="mt-1.5 text-[15px] text-muted">
                    This detail is protected. Enter your password to continue. It stays unlocked for
                    a few minutes.
                  </Primitive.Description>
                </div>
              </div>
              <div className="mt-5">
                <PasswordField
                  label="Password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {error && (
                <Alert tone="danger" className="mt-4">
                  {error}
                </Alert>
              )}
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => finish('cancelled')}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={pending} loadingText="Checking…">
                  Confirm
                </Button>
              </div>
            </form>
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used inside <StepUpProvider>');
  return ctx;
}
