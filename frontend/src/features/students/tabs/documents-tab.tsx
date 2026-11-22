import { useState } from 'react';
import { STUDENT_DOCUMENT_TYPES, STUDENT_DOCUMENT_TYPE_LABELS, type StudentAdminProfileDTO, type StudentDocumentDTO, type StudentDocumentType } from '@shared';
import { CircleCheck, Plus, Upload } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Can } from '@/components/sv/can';
import { DeleteDocumentButton, DeleteDocumentDialog, DocumentList, documentForm, DocumentUploadForm, useSignedDownload } from '@/components/sv/documents';
import { TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { useStudentMutation } from '../api';
import { DOCUMENTS_INTRO } from '../help-copy';
import { useStudentDocuments } from '../lifecycle-api';

/** Asks for a one-minute link and opens it. Used by the admin tab and the parent portal (the server checks who may download). */
export const useDocumentDownload = () => useSignedDownload((id) => `/student-documents/${id}/download`);

/** Documents tab (`?tab=documents`): the completeness line, upload (open by itself while there are no files), list, download, delete. */
export function DocumentsTab({ student, readOnly }: { student: StudentAdminProfileDTO; readOnly: boolean }) {
  const q = useStudentDocuments(student.studentId);
  const [documentType, setType] = useState<StudentDocumentType | ''>('');
  const [showForm, setShowForm] = useState<boolean | null>(null);
  const [deleting, setDeleting] = useState<StudentDocumentDTO | null>(null);
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

        {!readOnly && (
          <Can permission="student:documents">
            {formOpen ? (
              <DocumentUploadForm
                fileId="student-document-file"
                uploading={upload.isPending}
                onCancel={items.length > 0 ? () => setShowForm(false) : undefined}
                onUpload={async (file, name) => {
                  await upload.mutateAsync(documentForm(type, file, name));
                  setType('');
                  setShowForm(false);
                }}
                typeField={
                  <ComboboxField
                    label="Type"
                    value={type}
                    onChange={(v) => setType(v as StudentDocumentType)}
                    options={STUDENT_DOCUMENT_TYPES.map((t) => ({ value: t, label: STUDENT_DOCUMENT_TYPE_LABELS[t], hint: completeness?.missing.some((m) => m.documentType === t) ? 'Missing' : undefined }))}
                    searchPlaceholder="Search document types…"
                  />
                }
              />
            ) : (
              <Button variant="outline" onClick={() => openFor()}>
                <Plus /> Upload Document
              </Button>
            )}
          </Can>
        )}

        <DocumentList
          query={q}
          downloading={downloading}
          onDownload={(d) => void download(d)}
          items={items.map((d) => ({
            documentId: d.documentId,
            displayName: d.displayName,
            typeLabel: STUDENT_DOCUMENT_TYPE_LABELS[d.documentType],
            sizeBytes: d.sizeBytes,
            uploadedAt: d.uploadedAt,
            badge: d.issuedBySchool && (
              <Badge tone="brand">
                <CircleCheck aria-hidden /> Issued by the school
              </Badge>
            ),
            deleteAction: !readOnly && !d.issuedBySchool && (
              <Can permission="student:documents">
                <DeleteDocumentButton name={d.displayName} onClick={() => setDeleting(d)} />
              </Can>
            ),
          }))}
        />
      </Card>

      {deleting && <DeleteDocumentDialog name={deleting.displayName} onConfirm={() => remove.mutateAsync(deleting.documentId)} onClose={() => setDeleting(null)} />}
    </div>
  );
}
