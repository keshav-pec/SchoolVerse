/**
 * The dev outbox shows the emails the API would have sent (activation and reset links). It exists only where the API has
 * `DEV_OUTBOX` on, so the link to it appears in development and on a demo build with `VITE_DEV_OUTBOX=true`.
 */
export const SHOW_DEV_OUTBOX = import.meta.env.DEV || import.meta.env.VITE_DEV_OUTBOX === 'true';
