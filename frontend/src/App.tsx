import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { ActivatePage } from '@/features/auth/activate-page';
import { DevOutboxPage } from '@/features/auth/dev-outbox-page';
import { ForgotPasswordPage } from '@/features/auth/forgot-password-page';
import { LoginPage } from '@/features/auth/login-page';
import { ResetPasswordPage } from '@/features/auth/reset-password-page';
import { MyProfilePage } from '@/features/me/my-profile-page';
import { ColleaguesPage } from '@/features/people/colleagues-page';
import { EmployeePage } from '@/features/people/employee-page';
import { PeoplePage } from '@/features/people/people-page';
import { RequestsPage } from '@/features/people/requests-page';
import { PeopleSettingsPage } from '@/features/people/settings-page';
import { ParentLayout } from '@/features/parent/parent-layout';
import { ParentChildPage, ParentDocumentsPage, ParentHomePage } from '@/features/parent/parent-pages';
import { ParentRequestsPage } from '@/features/parent/parent-requests-page';
import { AttentionPage } from '@/features/students/attention-page';
import { ExitsPage } from '@/features/students/exits-page';
import { ImportPage } from '@/features/students/import-page';
import { ImportsPage } from '@/features/students/imports-page';
import { PromotionPage } from '@/features/students/promotion-page';
import { StudentRequestsPage } from '@/features/students/requests-page';
import { FamiliesPage } from '@/features/students/families-page';
import { FamilyPage } from '@/features/students/family-page';
import { MyStudentsPage } from '@/features/students/my-students-page';
import { StudentPage } from '@/features/students/student-page';
import { StudentsLayout } from '@/features/students/students-layout';
import { StudentsPage } from '@/features/students/students-page';
import { SHOW_DEV_OUTBOX } from '@/lib/dev';
import { SignupPage } from '@/features/auth/signup-page';
import { NotFoundPage } from '@/features/errors/not-found-page';
import { ForbiddenPage } from '@/features/errors/forbidden-page';
import { RouteError } from '@/features/errors/route-error';
import { HomePage } from '@/features/home/home-page';
import { AcademicStructurePage } from '@/features/academic/academic-structure-page';
import { AcademicsPage } from '@/features/academic/academics-page';
import { SessionPage } from '@/features/academic/session-page';
import { SubjectsPage } from '@/features/academic/subjects-page';
import { LocationDetailPage } from '@/features/locations/location-detail-page';
import { LocationsPage } from '@/features/locations/locations-page';
import { SchoolProfilePage } from '@/features/school-profile/school-profile-page';
import { AppShell } from '@/layouts/app-shell';
import { AuthLayout } from '@/layouts/auth-layout';
import { OverviewPage } from '@/features/setup/overview-page';
import { SetupWizardPage } from '@/features/setup/wizard/setup-wizard-page';
import { useAuth, useSession } from '@/lib/auth';
import {
  GuestOnly,
  RequireAcademicAccess,
  RequireAcademicConfig,
  RequireAuth,
  RequireDirectoryAccess,
  RequireFaculty,
  RequireParent,
  RequireStudentAccess,
  RequireStudentPermission,
  RequireStudentAdmin,
  RequirePeopleAdmin,
  RequireSetupAccess,
  RequireSetupComplete,
} from '@/routes/guards';

function SetupHome() {
  const { can } = useAuth();
  return can('setup:manage') ? <OverviewPage /> : <Navigate to="profile" replace />;
}

/** Admins get the Academic Setup dashboard; Faculty and Staff get the read-only Academic Structure page. */
function AcademicsHome() {
  const { can } = useAuth();
  return can('academic:view_config') ? <AcademicsPage /> : <AcademicStructurePage />;
}

/** Parents have their own portal; everyone else gets the dashboard. */
function Home() {
  const session = useSession();
  return session.user.role === 'PARENT' ? <Navigate to="/parent" replace /> : <HomePage />;
}

const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
      {
        element: <GuestOnly />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              { path: '/login', element: <LoginPage /> },
              { path: '/signup', element: <SignupPage /> },
            ],
          },
        ],
      },
      // Links from an email work whether or not someone is signed in on this browser.
      {
        element: <AuthLayout />,
        children: [
          { path: '/activate', element: <ActivatePage /> },
          { path: '/forgot-password', element: <ForgotPasswordPage /> },
          { path: '/reset-password', element: <ResetPasswordPage /> },
        ],
      },
      ...(SHOW_DEV_OUTBOX ? [{ path: '/dev/outbox', element: <DevOutboxPage /> }] : []),
      {
        element: <RequireAuth />,
        children: [
          // First-time setup runs full screen, outside the app shell.
          { path: '/setup', element: <SetupWizardPage /> },
          // The parent portal has its own simple layout (no admin sidebar).
          {
            path: '/parent',
            element: <RequireParent />,
            children: [
              {
                element: <ParentLayout />,
                children: [
                  { index: true, element: <ParentHomePage /> },
                  { path: 'children/:studentId', element: <ParentChildPage /> },
                  { path: 'documents', element: <ParentDocumentsPage /> },
                  { path: 'requests', element: <ParentRequestsPage /> },
                ],
              },
            ],
          },
          {
            element: <AppShell />,
            children: [
              { path: '/restricted', element: <ForbiddenPage /> },
              {
                element: <RequireSetupComplete />,
                children: [
                  { index: true, path: '/', element: <Home /> },
                  {
                    path: '/school-setup',
                    element: <RequireSetupAccess />,
                    children: [
                      // Admins land on the overview; Faculty and Staff, who can't see it, on the profile.
                      { index: true, element: <SetupHome /> },
                      { path: 'profile', element: <SchoolProfilePage /> },
                      { path: 'locations', element: <LocationsPage /> },
                      { path: 'locations/:locationId', element: <LocationDetailPage /> },
                    ],
                  },
                  {
                    path: '/people',
                    element: <RequirePeopleAdmin />,
                    children: [
                      { index: true, element: <PeoplePage /> },
                      {
                        path: 'requests',
                        element: <RequirePeopleAdmin permission="employee:approve_changes" />,
                        children: [{ index: true, element: <RequestsPage /> }],
                      },
                      {
                        path: 'settings',
                        element: <RequirePeopleAdmin permission="employee:manage" />,
                        children: [{ index: true, element: <PeopleSettingsPage /> }],
                      },
                      { path: ':employeeId', element: <EmployeePage /> },
                    ],
                  },
                  {
                    element: <RequireDirectoryAccess />,
                    children: [
                      { path: '/me', element: <MyProfilePage /> },
                      { path: '/colleagues', element: <ColleaguesPage /> },
                    ],
                  },
                  {
                    path: '/students',
                    element: <RequireStudentAccess />,
                    children: [
                      {
                        element: <RequireStudentAdmin />,
                        children: [
                          {
                            element: <StudentsLayout />,
                            children: [
                              { index: true, element: <StudentsPage /> },
                              { path: 'new', element: <StudentsPage /> },
                              { path: 'attention', element: <AttentionPage /> },
                              { path: 'exits', element: <ExitsPage /> },
                              {
                                element: <RequireStudentPermission permission="student:lifecycle" />,
                                children: [{ path: 'promotion', element: <PromotionPage /> }],
                              },
                              {
                                element: <RequireStudentPermission permission="student:import" />,
                                children: [
                                  { path: 'imports', element: <ImportsPage /> },
                                  { path: 'imports/:importId', element: <ImportPage /> },
                                ],
                              },
                              {
                                element: <RequireStudentPermission permission="student:approve_changes" />,
                                children: [{ path: 'requests', element: <StudentRequestsPage /> }],
                              },
                            ],
                          },
                        ],
                      },
                      // Admins get the full record; a teacher gets the short summary. Outside their sections it is Not Found.
                      { path: ':studentId', element: <StudentPage /> },
                    ],
                  },
                  {
                    path: '/families',
                    element: <RequireStudentAdmin />,
                    children: [
                      {
                        element: <StudentsLayout />,
                        children: [
                          { index: true, element: <FamiliesPage /> },
                          { path: ':personId', element: <FamilyPage /> },
                        ],
                      },
                    ],
                  },
                  {
                    path: '/my-students',
                    element: <RequireFaculty />,
                    children: [{ index: true, element: <MyStudentsPage /> }],
                  },
                  {
                    path: '/academics',
                    element: <RequireAcademicAccess />,
                    children: [
                      { index: true, element: <AcademicsHome /> },
                      {
                        element: <RequireAcademicConfig />,
                        children: [
                          { path: 'sessions/:sessionId', element: <SessionPage /> },
                          { path: 'subjects', element: <SubjectsPage /> },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
