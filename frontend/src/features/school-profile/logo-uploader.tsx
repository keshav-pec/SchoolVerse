import { useEffect, useRef, useState } from 'react';
import type { SchoolDTO } from '@shared';
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/errors';
import { initialsOf } from '@/lib/utils';
import { useRemoveLogo, useUploadLogo } from './api';

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Logo picker with an instant local preview. The file is validated on the server by its bytes, not its name. */
export function LogoUploader({ school, previewName, canEdit }: { school: SchoolDTO; previewName: string; canEdit: boolean }) {
  const upload = useUploadLogo(school.schoolId);
  const remove = useRemoveLogo(school.schoolId);
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const busy = upload.isPending || remove.isPending;
  // A saved logo whose file can't be loaded shows the initials instead of a broken image.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const shown = preview ?? (school.logoUrl && school.logoUrl !== brokenUrl ? school.logoUrl : null);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!TYPES.includes(file.type)) return setError('Upload a PNG, JPEG or WebP image.');
    if (file.size > MAX_BYTES) return setError('This file is too large. The maximum size is 2 MB.');
    setPreview(URL.createObjectURL(file));
    try {
      await upload.mutateAsync(file);
      toast.success('Logo updated.');
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPreview(null);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
      <div className="relative grid size-24 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-brand-soft to-lavender-soft">
        {shown ? <img src={shown} alt={`${previewName || school.displayName} logo`} className="size-full object-contain p-1.5" onError={() => setBrokenUrl(shown)} /> : <span aria-hidden="true" className="text-2xl font-extrabold text-brand">{initialsOf(previewName || school.displayName)}</span>}
        {busy && (
          <span className="absolute inset-0 grid place-items-center bg-white/70" role="status" aria-label="Uploading logo">
            <LoaderCircle className="size-6 animate-spin text-brand" />
          </span>
        )}
      </div>
      <div>
        <p className="text-sm font-semibold">School logo</p>
        <p className="text-[13px] text-muted">PNG, JPEG or WebP, up to 2 MB. Square images look best.</p>
        {canEdit && (
          <div className="mt-2.5 flex flex-wrap gap-2">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose logo file" onChange={(e) => void onPick(e.target.files?.[0])} />
            <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>
              <ImagePlus /> {school.logoUrl ? 'Replace logo' : 'Upload logo'}
            </Button>
            {school.logoUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setError(null);
                  try {
                    await remove.mutateAsync();
                    toast.success('Logo removed.');
                  } catch (err) {
                    setError(messageFor(err));
                  }
                }}
              >
                <Trash2 className="text-danger" /> Remove
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[13px] font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
