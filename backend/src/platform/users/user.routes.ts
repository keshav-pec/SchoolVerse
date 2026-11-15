import { Router } from 'express';
import { paginationQuerySchema, uuidSchema, type PaginatedDTO, type UserDTO } from '@shared';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../auth/authenticate';
import { requirePermission } from '../rbac/require-permission';
import { scoped } from '../rbac/tenant-context';
import { toUserDTO } from './user.mapper';
import { User, type UserDoc } from './user.model';

/** Minimal read-only user directory (full user management is a later module). */
export const userRouter = Router();
userRouter.use(authenticate, requirePermission('user:view'));

userRouter.get('/', validate({ query: paginationQuerySchema }), async (req, res) => {
  const { page, pageSize } = res.locals.query as z.infer<typeof paginationQuerySchema>;
  const filter = scoped(req);
  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: 1 }).skip((page - 1) * pageSize).limit(pageSize).lean<UserDoc[]>(),
    User.countDocuments(filter),
  ]);
  const body: PaginatedDTO<UserDTO> = { items: items.map(toUserDTO), page, pageSize, total };
  ok(res, body);
});

userRouter.get('/:userId', validate({ params: z.object({ userId: uuidSchema }) }), async (req, res) => {
  const user = await User.findOne(scoped(req, { _id: req.params.userId })).lean<UserDoc>();
  // Cross-tenant ids look exactly like missing ids (404, never 403) to prevent enumeration.
  if (!user) throw AppError.notFound('User not found.');
  ok(res, toUserDTO(user));
});
