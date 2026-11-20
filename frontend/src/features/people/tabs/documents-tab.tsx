import type { EmployeeProfileDTO } from '@shared';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabIntro } from '@/components/sv/help';
import { useEmployeeDocuments } from '../api';
import { DocumentsPanel } from '../documents-panel';

export function DocumentsTab({ employee }: { employee: EmployeeProfileDTO }) {
  const documents = useEmployeeDocuments(employee.employeeId);
  return (
    <div className="space-y-4">
      <TabIntro title="Documents" need="optional">
        <p>
          Scans of their papers: ID proof, address proof, degree certificates, experience letters,
          police verification and the job contract. Upload them as you collect them.
        </p>
        <p>Files are private. Only School Admins and the employee can open them.</p>
      </TabIntro>
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
    </div>
  );
}
