import { useEffect, useRef, useState } from 'react';
import type { RevealedValueDTO } from '@shared';
import { Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/errors';
import { isStepUpCancelled } from '@/lib/step-up';

/**
 * A masked value with a Reveal button. The real value comes from the server only after permission and step-up, is shown
 * for the time the server names (30 seconds), and is then masked again. The page never keeps it longer than that.
 */
export function RevealableValue({
  label,
  masked,
  reveal,
}: {
  label: string;
  masked: string;
  reveal: () => Promise<RevealedValueDTO>;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [seconds, setSeconds] = useState(30);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setValue(null);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const show = async () => {
    setPending(true);
    try {
      const result = await reveal();
      setValue(result.value);
      setSeconds(result.hideAfterSeconds);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, result.hideAfterSeconds * 1000);
    } catch (err) {
      if (!isStepUpCancelled(err)) toast.error(messageFor(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className="font-mono text-sm font-semibold tracking-wide"
        data-revealed={value !== null || undefined}
        aria-live="polite"
      >
        {value ?? masked}
      </span>
      {value === null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void show()}
          loading={pending}
          loadingText="Checking…"
          aria-label={`Show ${label}`}
        >
          <Eye /> Show
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={hide}
            aria-label={`Hide ${label}`}
          >
            <EyeOff /> Hide
          </Button>
          <span className="text-xs text-muted">Hides again in {seconds} second{seconds === 1 ? '' : 's'}</span>
        </>
      )}
    </span>
  );
}
