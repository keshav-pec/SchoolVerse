import { useRef, useState } from 'react';
import { MAX_DOCUMENT_BYTES, STUDENT_DOCUMENT_TYPES, STUDENT_DOCUMENT_TYPE_LABELS, type SignedFileLinkDTO, type StudentAdminProfileDTO, type StudentDocumentDTO, type StudentDocumentType } from '@shared';
import { CircleCheck, Download, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { openSignedLink } from '../../people/api';
import { useStudentMutation } from '../api';
import { DOCUMENTS_INTRO } from '../help-copy';
import { useStudentDocuments } from '../lifecycle-api';

export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Asks for a one-minute link and opens it. Used by the admin tab and the parent portal (the server checks who may download). */
export function useDocumentDownload() {
  const [downloading, setDownloading] = useState<string | null>(null);
  const download = async (doc: Pick<StudentDocumentDTO, 'documentId'>) => {
    setDownloading(doc.documentId);
    try {
      const link = await api.post<SignedFileLinkDTO>(`/student-documents/${doc.documentId}/download`);
      openSignedLink(link.url);
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setDownloading(null);
    }
  };
  return { download, downloading };
}

/** Documents tab (`?tab=documents`): the completeness line, upload (open by itself while there are no files), list, download, delete. */
export function DocumentsTab({ student, readOnly }: { student: StudentAdminProfileDTO; readOnly: boolean }) {
  const q = useStudentDocuments(student.studentId);
  const [documentType, setType] = useState<StudentDocumentType | ''>('');
  const [displayName, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState<boolean | null>(null);
  const [deleting, setDeleting] = useState<StudentDocumentDTO | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { download, downloading } = useDocumentDownload();

  const items = q.data?.items ?? [];
  const completeness = q.data?.completeness;
  const formOpen = showForm ?? (!q.isLoading && !q.isError && items.length === 0);
  const firstMissing = completeness?.missing[0]?.documentType;
  const type = documentType || firstMissing || 'BIRTH_CERTIFICATE';

  const upload = useStudentMutation((form: FormData) => api.upload<StudentDocumentDTO>(`/students/${student.studentId}/documents`, form), { quiet: true, success: 'Document uploaded.' });
  const remove = useStudentMutation((id: string) => api.delete<void>(`/student-documents/${id}`), { quiet: true, success: 'Document deleted.' });

  const openFor = (t?: StudentDocumentType) => {
    if (t) setType(t);
    setShowForm(true);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!file) return setError('Choose a file to upload.');
    if (file.size > MAX_DOCUMENT_BYTES) return setError('This file is too large. The maximum size is 5 MB.');
    // Text fields first, then the file: the server reads them in that order.
    const form = new FormData();
    form.append('documentType', type);
    if (displayName.trim()) form.append('displayName', displayName.trim());
    form.append('file', file);
    try {
      await upload.mutateAsync(form);
      setFile(null);
      setName('');
      setType('');
      if (input.current) input.current.value = '';
      setShowForm(false);
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <div className="space-y-4">
      <TabIntro title="About documents">{DOCUMENTS_INTRO}</TabIntro>
      <Card className="space-y-4">
        {completeness && (
          <Alert tone={completeness.missing.length === 0 ? 'success' : 'warning'} title={completeness.missing.length === 0 ? 'All documents are in' : 'Documents still missing'}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex-1" data-testid="documents-completeness">
                {completeness.message}
              </span>
              {completeness.missing.length > 0 && !readOnly && (
                <Can permission="student:documents">
                  <Button size="sm" variant="outline" onClick={() => openFor(firstMissing)}>
                    <Upload /> Upload {completeness.missing[0]!.label}
                  </Button>
                </Can>
              )}
            </div>
          </Alert>
        )}

        {!readOnly && !formOpen && (
          <Can permission="student:documents">
            <Button variant="outline" onClick={() => openFor()}>
              <Plus /> Upload Document
            </Button>
          </Can>
        )}
        {!readOnly && formOpen && (
          <Can permission="student:documents">
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
                <ComboboxField
                  label="Type"
                  value={type}
                  onChange={(v) => setType(v as StudentDocumentType)}
                  options={STUDENT_DOCUMENT_TYPES.map((t) => ({ value: t, label: STUDENT_DOCUMENT_TYPE_LABELS[t], hint: completeness?.missing.some((m) => m.documentType === t) ? 'Missing' : undefined }))}
                  searchPlaceholder="Search document types…"
                />
                <TextField label="Name" hint="Optional. Leave empty to use the file’s own name." value={displayName} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="student-document-file" className="text-sm font-semibold">
                  File
                </label>
                <input
                  ref={input}
                  id="student-document-file"
                  type="file"
                  accept="application/pdf,image/png,image/jpeg"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-4 file:py-2.5 file:font-semibold file:text-brand"
                />
                <p className="text-[13px] text-muted">A PDF or a photo (PNG or JPEG), up to 5 MB. We check every file before saving it.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={upload.isPending} loadingText="Uploading…">
                  <Upload /> Upload
                </Button>
                {items.length > 0 && (
                  <Button type="button" variant="ghost" onClick={() => setShowForm(false)} disabled={upload.isPending}>
                    Cancel
                  </Button>
                )}
              </div>
            </form>
          </Can>
        )}

        {q.isLoading ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : items.length === 0 ? (
          <EmptyState illustration={<FileText className="size-10 text-muted" aria-hidden="true" />} title="No documents yet" description="Uploaded files are private. Nobody can open them without signing in." />
        ) : (
          <ul className="divide-y divide-line" aria-label="Documents">
            {items.map((d) => (
              <li key={d.documentId} className="flex flex-wrap items-center gap-3 py-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
                  <FileText className="size-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    <span className="truncate">{d.displayName}</span>
                    {d.issuedBySchool && (
                      <Badge tone="brand">
                        <CircleCheck aria-hidden /> Issued by the school
                      </Badge>
                    )}
                  </p>
                  <p className="text-[13px] text-muted">
                    {STUDENT_DOCUMENT_TYPE_LABELS[d.documentType]} · {formatSize(d.sizeBytes)} · {formatDateTime(d.uploadedAt)}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void download(d)} loading={downloading === d.documentId} loadingText="Opening…" aria-label={`Download ${d.displayName}`}>
                  <Download /> Download
                </Button>
                {!readOnly && !d.issuedBySchool && (
                  <Can permission="student:documents">
                    <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(d)} aria-label={`Delete ${d.displayName}`}>
                      <Trash2 />
                    </Button>
                  </Can>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          tone="danger"
          icon={<Trash2 className="size-5" />}
          title={`Delete ${deleting.displayName}?`}
          description="The file is removed for good. The deletion is recorded in the history."
          confirmLabel="Delete Document"
          loadingLabel="Deleting…"
          onConfirm={async () => void (await remove.mutateAsync(deleting.documentId))}
        />
      )}
    </div>
  );
}
