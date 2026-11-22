import { useRef, useState, type ReactNode } from 'react';
import { MAX_DOCUMENT_BYTES, type SignedFileLinkDTO } from '@shared';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';

/**
 * The pieces shared by every documents list (staff, students, parents): upload form, list, download by a one-minute signed link,
 * and the delete dialog. Each screen keeps its own document types, API paths and permissions.
 */

export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Opens a signed download link the way a browser would, without leaving the page. */
export function openSignedLink(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Asks for a one-minute link at `pathFor(documentId)` and opens it. `downloading` is the document being fetched. */
export function useSignedDownload(pathFor: (documentId: string) => string) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = async (doc: { documentId: string }) => {
    setDownloading(doc.documentId);
    try {
      const link = await api.post<SignedFileLinkDTO>(pathFor(doc.documentId));
      openSignedLink(link.url);
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setDownloading(null);
    }
  };
  return { download, downloading };
}

/** “Upload a document”: the type picker (from the caller), an optional name, and the file. The server checks every file. */
export function DocumentUploadForm({
  fileId,
  typeField,
  onUpload,
  uploading,
  onCancel,
}: {
  fileId: string;
  typeField: ReactNode;
  /** Gets the file and the trimmed name (empty when not given). Throw to show the error in the form. */
  onUpload: (file: File, displayName: string) => Promise<unknown>;
  uploading: boolean;
  /** Shown only when given (there are files already, so the form can close). */
  onCancel?: () => void;
}) {
  const [displayName, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const submit = async () => {
    setError(null);
    if (!file) return setError('Choose a file to upload.');
    if (file.size > MAX_DOCUMENT_BYTES) return setError('This file is too large. The maximum size is 5 MB.');
    try {
      await onUpload(file, displayName.trim());
      setFile(null);
      setName('');
      if (input.current) input.current.value = '';
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <form
      className="space-y-4 rounded-xl border border-dashed border-line bg-canvas/60 p-4"
      noValidate
      aria-label="Upload a document"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-semibold">Upload a document</p>
      <p className="-mt-2 text-[13px] text-muted">Choose what it is, pick the file from your computer or phone, then press Upload.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        {typeField}
        <TextField label="Name" hint="Optional. Leave empty to use the file’s own name." value={displayName} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fileId} className="text-sm font-semibold">
          File
        </label>
        <input
          ref={input}
          id={fileId}
          type="file"
          accept="application/pdf,image/png,image/jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-4 file:py-2.5 file:font-semibold file:text-brand"
        />
        <p className="text-[13px] text-muted">A PDF or a photo (PNG or JPEG), up to 5 MB. We check every file before saving it.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={uploading} loadingText="Uploading…">
          <Upload /> Upload
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setError(null);
              onCancel();
            }}
            disabled={uploading}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** Text fields first, then the file: the server reads them in that order. */
export function documentForm(documentType: string, file: File, displayName: string) {
  const form = new FormData();
  form.append('documentType', documentType);
  if (displayName) form.append('displayName', displayName);
  form.append('file', file);
  return form;
}

export interface DocumentLine {
  documentId: string;
  displayName: string;
  typeLabel: string;
  sizeBytes: number;
  uploadedAt: string;
  badge?: ReactNode;
  /** The delete button, when this person may delete this file. */
  deleteAction?: ReactNode;
}

interface QueryState {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
}

/** Loading, error, “No documents yet”, or one row per file with Download (and Delete, when given). */
export function DocumentList({ query, items, onDownload, downloading }: { query: QueryState; items: DocumentLine[]; onDownload: (doc: DocumentLine) => void; downloading: string | null }) {
  if (query.isLoading) return <Skeleton className="h-24" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  if (items.length === 0) return <EmptyState illustration={<FileText className="size-10 text-muted" aria-hidden="true" />} title="No documents yet" description="Uploaded files are private. Nobody can open them without signing in." />;
  return (
    <ul className="divide-y divide-line" aria-label="Documents">
      {items.map((d) => (
        <li key={d.documentId} className="flex flex-wrap items-center gap-3 py-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
            <FileText className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              <span className="truncate">{d.displayName}</span>
              {d.badge}
            </p>
            <p className="text-[13px] text-muted">
              {d.typeLabel} · {formatSize(d.sizeBytes)} · {formatDateTime(d.uploadedAt)}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => onDownload(d)} loading={downloading === d.documentId} loadingText="Opening…" aria-label={`Download ${d.displayName}`}>
            <Download /> Download
          </Button>
          {d.deleteAction}
        </li>
      ))}
    </ul>
  );
}

/** The small bin button for a document row. */
export function DeleteDocumentButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={`Delete ${name}`}>
      <Trash2 />
    </Button>
  );
}

/** “Delete Birth certificate?” The file goes for good; the history keeps the deletion. */
export function DeleteDocumentDialog({ name, onConfirm, onClose }: { name: string; onConfirm: () => Promise<unknown>; onClose: () => void }) {
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone="danger"
      icon={<Trash2 className="size-5" />}
      title={`Delete ${name}?`}
      description="The file is removed for good. The deletion is recorded in the history."
      confirmLabel="Delete Document"
      loadingLabel="Deleting…"
      onConfirm={async () => void (await onConfirm())}
    />
  );
}
