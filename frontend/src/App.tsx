import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { LoginPage } from '@/features/auth/login-page';
import { SignupPage } from '@/features/auth/signup-page';
import { NotFoundPage } from '@/features/errors/not-found-page';
import { ForbiddenPage } from '@/features/errors/forbidden-page';
import { RouteError } from '@/features/errors/route-error';
import { HomePage } from '@/features/home/home-page';
import { LocationDetailPage } from '@/features/locations/location-detail-page';
import { LocationsPage } from '@/features/locations/locations-page';
import { SchoolProfilePage } from '@/features/school-profile/school-profile-page';
import { AppShell } from '@/layouts/app-shell';
import { AuthLayout } from '@/layouts/auth-layout';
import { OverviewPage } from '@/features/setup/overview-page';
import { SetupWizardPage } from '@/features/setup/wizard/setup-wizard-page';
import { useAuth } from '@/lib/auth';
import { GuestOnly, RequireAuth, RequireSetupAccess, RequireSetupComplete } from '@/routes/guards';

function SetupHome() {
  const { can } = useAuth();
  return can('setup:manage') ? <OverviewPage /> : <Navigate to="profile" replace />;
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
      {
        element: <RequireAuth />,
        children: [
          // First-time setup runs full screen, outside the app shell.
          { path: '/setup', element: <SetupWizardPage /> },
          {
            element: <AppShell />,
            children: [
              { path: '/restricted', element: <ForbiddenPage /> },
              {
                element: <RequireSetupComplete />,
                children: [
                  { index: true, path: '/', element: <HomePage /> },
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
