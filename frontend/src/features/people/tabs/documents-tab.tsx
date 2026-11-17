import type { EmployeeProfileDTO } from '@shared';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useEmployeeDocuments } from '../api';
import { DocumentsPanel } from '../documents-panel';

export function DocumentsTab({ employee }: { employee: EmployeeProfileDTO }) {
  const documents = useEmployeeDocuments(employee.employeeId);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            Private files. A download link works for one minute, and every download is recorded.
          </CardDescription>
        </div>
      </CardHeader>
      <DocumentsPanel
        documents={documents}
        uploadPath={`/employees/${employee.employeeId}/documents`}
        canDelete
        readOnly={employee.readOnly}
      />
    </Card>
  );
}
