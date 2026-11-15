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
import { GuestOnly, RequireAuth, RequireSetupAccess } from '@/routes/guards';

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
          {
            element: <AppShell />,
            children: [
              { index: true, path: '/', element: <HomePage /> },
              { path: '/restricted', element: <ForbiddenPage /> },
              {
                path: '/school-setup',
                element: <RequireSetupAccess />,
                children: [
                  // The setup overview arrives with the wizard; until then profile is the entry point.
                  { index: true, element: <Navigate to="profile" replace /> },
                  { path: 'profile', element: <SchoolProfilePage /> },
                  { path: 'locations', element: <LocationsPage /> },
                  { path: 'locations/:locationId', element: <LocationDetailPage /> },
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
