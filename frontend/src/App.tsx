import { createBrowserRouter, RouterProvider } from 'react-router';
import { LoginPage } from '@/features/auth/login-page';
import { SignupPage } from '@/features/auth/signup-page';
import { NotFoundPage } from '@/features/errors/not-found-page';
import { RouteError } from '@/features/errors/route-error';
import { HomePage } from '@/features/home/home-page';
import { AppShell } from '@/layouts/app-shell';
import { AuthLayout } from '@/layouts/auth-layout';
import { GuestOnly, RequireAuth } from '@/routes/guards';

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
        children: [{ element: <AppShell />, children: [{ index: true, path: '/', element: <HomePage /> }] }],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
