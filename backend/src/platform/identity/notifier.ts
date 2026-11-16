import { Schema, model } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { baseSchemaOptions, uuidPrimaryKey } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Email/SMS port. There is no provider yet: development, tests and demos write to the `dev_outbox` collection (shown at
 * `GET /api/v1/dev/outbox`). A real provider implements `Notifier` later and nothing else changes.
 */
export const NOTIFICATION_TEMPLATES = ['ACTIVATION', 'PASSWORD_RESET'] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATES)[number];

export interface Notification {
  tenantId: string;
  to: string;
  template: NotificationTemplate;
  link: string;
}

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

export interface DevOutboxDoc {
  _id: string;
  tenantId: string;
  to: string;
  template: NotificationTemplate;
  link: string;
  createdAt: Date;
}

const devOutboxSchema = new Schema<DevOutboxDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    to: { type: String, required: true },
    template: { type: String, enum: NOTIFICATION_TEMPLATES, required: true },
    link: { type: String, required: true },
  },
  { ...baseSchemaOptions('dev_outbox'), timestamps: { createdAt: true, updatedAt: false } },
);
devOutboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
devOutboxSchema.plugin(tenantScopePlugin);

export const DevOutbox = model<DevOutboxDoc>('DevOutbox', devOutboxSchema);

class DevOutboxNotifier implements Notifier {
  async send({ tenantId, to, template, link }: Notification) {
    await DevOutbox.create({ tenantId, to, template, link });
  }
}

/** Without a provider and without the dev outbox nothing is delivered. The link is a credential, so it is never logged. */
class UndeliveredNotifier implements Notifier {
  async send({ template }: Notification) {
    logger.warn({ template }, 'No email provider is configured, so this message was not delivered');
  }
}

export const notifier: Notifier = env.DEV_OUTBOX ? new DevOutboxNotifier() : new UndeliveredNotifier();

/** Sending must never undo the change that caused it, so a failure is logged and the admin can resend. */
export async function sendSafely(notification: Notification) {
  try {
    await notifier.send(notification);
  } catch (err) {
    logger.error({ err, template: notification.template }, 'could not send a notification');
  }
}

export const activationLink = (token: string) => `${env.APP_BASE_URL}/activate?token=${encodeURIComponent(token)}`;
export const resetLink = (token: string) => `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
