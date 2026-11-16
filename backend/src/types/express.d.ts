import type { Permission, Role } from '@shared';

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
  permissions: Permission[];
  sessionId: string | null;
  /** Last step-up on this session, if any. */
  stepUpAt: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}

export {};
