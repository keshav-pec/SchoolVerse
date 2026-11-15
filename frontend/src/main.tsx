import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import '@fontsource-variable/inter';
import '@fontsource-variable/plus-jakarta-sans';
import './styles/theme.css';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { queryClient } from './lib/query-client';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
        <Toaster position="top-right" richColors closeButton toastOptions={{ style: { fontFamily: 'var(--font-sans)', borderRadius: 12 } }} />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
