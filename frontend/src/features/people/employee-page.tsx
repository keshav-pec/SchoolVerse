import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EMPLOYEE_CATEGORY_LABELS } from '@shared';
import {
  ArrowLeft,
  BookOpenCheck,
  Contact,
  FileText,
  History,
  KeyRound,
  LayoutGrid,
  Lock,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfoTip } from '@/components/ui/tooltip';
import { EmployeeStatusPill } from '@/components/sv/employee-status';
import { ErrorState } from '@/components/sv/error-state';
import { formatDateOnly } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useEmployee } from './api';
import { LifecycleActions } from './lifecycle-actions';
import { NextSteps } from './next-steps';
import { AccountTab } from './tabs/account-tab';
import { AcademicTab } from './tabs/academic-tab';
import { ContactTab } from './tabs/contact-tab';
import { DocumentsTab } from './tabs/documents-tab';
import { HistoryTab } from './tabs/history-tab';
import { OverviewTab } from './tabs/overview-tab';
import { PersonalTab } from './tabs/personal-tab';
import { ResponsibilitiesTab } from './tabs/responsibilities-tab';
import { ActivateFromChecklist } from './activate-from-checklist';
import { STATUS_HELP } from './help-copy';

/** `/people/:employeeId`: one employee, with a tab for each part of their record (PRD §11). */
export function EmployeePage() {
  const { employeeId } = useParams();
  const { can } = useAuth();
  const q = useEmployee(employeeId);
  const [params, setParams] = useSearchParams();
  const [activating, setActivating] = useState(false);

  if (q.isLoading) {
    return (
      <div role="status" aria-label="Loading employee" className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
      </div>
    );
  }
  if (q.isError || !q.data)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;

  const employee = q.data;
  const isFaculty = employee.employeeCategory === 'FACULTY';
  // Employment details now live on Overview; old links to ?tab=employment still land there.
  const requested = params.get('tab') ?? 'overview';
  const tab = requested === 'employment' ? 'overview' : requested;
  const setTab = (next: string) =>
    setParams((prev) => new URLSearchParams({ ...Object.fromEntries(prev), tab: next }), {
      replace: true,
    });
  const exitInfo = employee.exit;

  return (
    <>
      <Link
        to="/people"
        className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Faculty &amp; Staff
      </Link>

      <header className="mb-4 flex flex-col gap-3 rounded-card border border-line bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <Avatar name={employee.fullName} className="size-12 text-lg" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] leading-tight font-extrabold break-words">
            {employee.fullName}
          </h1>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono font-semibold text-ink">{employee.employeeCode}</span> ·{' '}
            {employee.designation.name} · {employee.department.name} ·{' '}
            {EMPLOYEE_CATEGORY_LABELS[employee.employeeCategory]}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <EmployeeStatusPill status={employee.status} />
            <InfoTip label="What the statuses mean">{STATUS_HELP}</InfoTip>
            {employee.status === 'NOTICE_PERIOD' && exitInfo && (
              <span className="text-[13px] text-muted">
                Leaves on {formatDateOnly(exitInfo.exitDate)}
              </span>
            )}
          </div>
        </div>
        {can('employee:manage') && <LifecycleActions employee={employee} />}
      </header>

      {employee.readOnly && (
        <Alert tone="warning" title="This employee has left the school" className="mb-4">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-4" aria-hidden="true" /> The record is read-only
            {exitInfo ? ` (left on ${formatDateOnly(exitInfo.exitDate)})` : ''}. Everything stays
            viewable for history, but nothing can be changed.
          </span>
        </Alert>
      )}

      {employee.status === 'ONBOARDING' && can('employee:manage') && (
        <NextSteps employee={employee} onGoTo={setTab} onActivate={() => setActivating(true)} />
      )}
      {activating && (
        <ActivateFromChecklist employee={employee} onClose={() => setActivating(false)} />
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Employee record">
          <TabsTrigger value="overview">
            <LayoutGrid /> Overview
          </TabsTrigger>
          {isFaculty ? (
            <TabsTrigger value="academic">
              <BookOpenCheck /> Classes &amp; Subjects
            </TabsTrigger>
          ) : (
            <TabsTrigger value="responsibilities">
              <Wrench /> Responsibilities
            </TabsTrigger>
          )}
          <TabsTrigger value="contact">
            <Contact /> Contact
          </TabsTrigger>
          {can('employee:view_restricted') && (
            <TabsTrigger value="personal">
              <ShieldCheck /> IDs &amp; Bank
            </TabsTrigger>
          )}
          {can('employee:documents') && (
            <TabsTrigger value="documents">
              <FileText /> Documents
            </TabsTrigger>
          )}
          {can('user:view') && (
            <TabsTrigger value="account">
              <KeyRound /> Login
            </TabsTrigger>
          )}
          <TabsTrigger value="history">
            <History /> History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab employee={employee} />
        </TabsContent>
        {isFaculty ? (
          <TabsContent value="academic">
            <AcademicTab employee={employee} />
          </TabsContent>
        ) : (
          <TabsContent value="responsibilities">
            <ResponsibilitiesTab employee={employee} />
          </TabsContent>
        )}
        <TabsContent value="contact">
          <ContactTab employee={employee} />
        </TabsContent>
        {can('employee:view_restricted') && (
          <TabsContent value="personal">
            <PersonalTab employee={employee} />
          </TabsContent>
        )}
        {can('employee:documents') && (
          <TabsContent value="documents">
            <DocumentsTab employee={employee} />
          </TabsContent>
        )}
        {can('user:view') && (
          <TabsContent value="account">
            <AccountTab employee={employee} />
          </TabsContent>
        )}
        <TabsContent value="history">
          <HistoryTab employeeId={employee.employeeId} />
        </TabsContent>
      </Tabs>
    </>
  );
}
