import { useRef, useState } from 'react';
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABELS,
  MAX_DOCUMENT_BYTES,
  type DocumentType,
  type EmployeeDocumentDTO,
  type SignedFileLinkDTO,
} from '@shared';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { openSignedLink, usePeopleMutation } from './api';

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

interface Props {
  documents: {
    data?: EmployeeDocumentDTO[];
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
    isFetching: boolean;
  };
  /** Where a new file goes (`/employees/:id/documents` or `/me/documents`). */
  uploadPath: string;
  /** Admins can delete; employees cannot delete their own uploads. */
  canDelete: boolean;
  /** Exited employees' documents can be read, not changed. */
  readOnly?: boolean;
}

/** Upload, list, download (by a one-minute signed link) and delete. Used on the profile tab and on /me. */
export function DocumentsPanel({ documents, uploadPath, canDelete, readOnly }: Props) {
  const [documentType, setType] = useState<DocumentType>('ID_PROOF');
  const [displayName, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EmployeeDocumentDTO | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = usePeopleMutation(
    (form: FormData) => api.upload<EmployeeDocumentDTO>(uploadPath, form),
    { quiet: true, success: 'Document uploaded.' },
  );
  const remove = usePeopleMutation((id: string) => api.delete<void>(`/employee-documents/${id}`), {
    quiet: true,
    success: 'Document deleted.',
  });
  const [downloading, setDownloading] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!file) return setError('Choose a file to upload.');
    if (file.size > MAX_DOCUMENT_BYTES)
      return setError('This file is too large. The maximum size is 5 MB.');
    // Text fields first, then the file: the server reads them in that order.
    const form = new FormData();
    form.append('documentType', documentType);
    if (displayName.trim()) form.append('displayName', displayName.trim());
    form.append('file', file);
    try {
      await upload.mutateAsync(form);
      setFile(null);
      setName('');
      if (input.current) input.current.value = '';
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const download = async (doc: EmployeeDocumentDTO) => {
    setDownloading(doc.documentId);
    try {
      const link = await api.post<SignedFileLinkDTO>(
        `/employee-documents/${doc.documentId}/download`,
      );
      openSignedLink(link.url);
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      {!readOnly && (
        <form
          className="space-y-4 rounded-xl border border-dashed border-line bg-canvas/60 p-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm font-semibold">Upload a document</p>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Type"
              value={documentType}
              onChange={(e) => setType(e.target.value as DocumentType)}
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Name"
              hint="Optional. Defaults to the file name."
              value={displayName}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="document-file" className="text-sm font-semibold">
              File
            </label>
            <input
              ref={input}
              id="document-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-4 file:py-2.5 file:font-semibold file:text-brand"
            />
            <p className="text-[13px] text-muted">
              PDF, PNG or JPEG, up to 5 MB. The file is checked on the server before it is stored.
            </p>
          </div>
          <Button type="submit" loading={upload.isPending} loadingText="Uploading…">
            <Upload /> Upload
          </Button>
        </form>
      )}

      {documents.isLoading ? (
        <Skeleton className="h-24" />
      ) : documents.isError ? (
        <ErrorState
          error={documents.error}
          onRetry={() => void documents.refetch()}
          retrying={documents.isFetching}
        />
      ) : (documents.data ?? []).length === 0 ? (
        <EmptyState
          illustration={<FileText className="size-10 text-muted" aria-hidden="true" />}
          title="No documents yet"
          description="Uploaded documents are private. They are never shown by a permanent link."
        />
      ) : (
        <ul className="divide-y divide-line" aria-label="Documents">
          {(documents.data ?? []).map((d) => (
            <li key={d.documentId} className="flex flex-wrap items-center gap-3 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
                <FileText className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{d.displayName}</p>
                <p className="text-[13px] text-muted">
                  {DOCUMENT_TYPE_LABELS[d.documentType]} · {formatSize(d.sizeBytes)} ·{' '}
                  {formatDateTime(d.uploadedAt)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void download(d)}
                loading={downloading === d.documentId}
                loadingText="Opening…"
                aria-label={`Download ${d.displayName}`}
              >
                <Download /> Download
              </Button>
              {canDelete && !readOnly && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleting(d)}
                  aria-label={`Delete ${d.displayName}`}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          tone="danger"
          icon={<Trash2 className="size-5" />}
          title={`Delete ${deleting.displayName}?`}
          description="The file is removed for good. The deletion is recorded in the history."
          confirmLabel="Delete document"
          loadingLabel="Deleting…"
          onConfirm={async () => {
            await remove.mutateAsync(deleting.documentId);
          }}
        />
      )}
    </div>
  );
}
