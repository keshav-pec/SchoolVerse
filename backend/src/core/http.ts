import type { Response, Router } from 'express';

/** Standard success envelope: `{ data }`. */
export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, 201);
}

export function noContent(res: Response) {
  return res.status(204).end();
}

/** `parent.use(path, child)` that also records `path`, so the generated API docs can list the child's routes. */
export function mount(parent: Router, path: string, child: Router) {
  if (path) parent.use(path, child);
  else parent.use(child);
  (parent.stack.at(-1) as { mountPath?: string }).mountPath = path;
}
