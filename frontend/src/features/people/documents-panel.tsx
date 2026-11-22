import { useState } from 'react';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS, type DocumentType, type EmployeeDocumentDTO } from '@shared';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ComboboxField } from '@/components/ui/field';
import { DeleteDocumentButton, DeleteDocumentDialog, DocumentList, documentForm, DocumentUploadForm, useSignedDownload } from '@/components/sv/documents';
import { api } from '@/lib/api';
import { usePeopleMutation } from './api';

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
  const [deleting, setDeleting] = useState<EmployeeDocumentDTO | null>(null);
  // The upload form is open while there is nothing yet; once files exist it hides behind a button.
  const [showForm, setShowForm] = useState<boolean | null>(null);
  const items = documents.data ?? [];
  const formOpen = showForm ?? (!documents.isLoading && !documents.isError && items.length === 0);
  const { download, downloading } = useSignedDownload((id) => `/employee-documents/${id}/download`);

  const upload = usePeopleMutation((form: FormData) => api.upload<EmployeeDocumentDTO>(uploadPath, form), { quiet: true, success: 'Document uploaded.' });
  const remove = usePeopleMutation((id: string) => api.delete<void>(`/employee-documents/${id}`), { quiet: true, success: 'Document deleted.' });

  return (
    <div className="space-y-6">
      {!readOnly && !formOpen && (
        <Button variant="outline" onClick={() => setShowForm(true)}>
          <Plus /> Upload Document
        </Button>
      )}
      {!readOnly && formOpen && (
        <DocumentUploadForm
          fileId="document-file"
          uploading={upload.isPending}
          onCancel={items.length > 0 ? () => setShowForm(false) : undefined}
          onUpload={async (file, name) => {
            await upload.mutateAsync(documentForm(documentType, file, name));
            setShowForm(false);
          }}
          typeField={
            <ComboboxField
              label="Type"
              value={documentType}
              onChange={(v) => setType(v as DocumentType)}
              options={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_TYPE_LABELS[t] }))}
              searchPlaceholder="Search document types…"
            />
          }
        />
      )}

      <DocumentList
        query={documents}
        downloading={downloading}
        onDownload={(d) => void download(d)}
        items={items.map((d) => ({
          documentId: d.documentId,
          displayName: d.displayName,
          typeLabel: DOCUMENT_TYPE_LABELS[d.documentType],
          sizeBytes: d.sizeBytes,
          uploadedAt: d.uploadedAt,
          deleteAction: canDelete && !readOnly ? <DeleteDocumentButton name={d.displayName} onClick={() => setDeleting(d)} /> : null,
        }))}
      />

      {deleting && <DeleteDocumentDialog name={deleting.displayName} onConfirm={() => remove.mutateAsync(deleting.documentId)} onClose={() => setDeleting(null)} />}
    </div>
  );
}
