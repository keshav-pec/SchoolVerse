import { ERROR_CODES } from '@shared';
import { z, type ZodType } from 'zod';
import { authenticate } from '../platform/auth/authenticate';

/**
 * Builds the OpenAPI document from the live Express routers, so it can't drift from the code:
 * paths and methods from the router stack, auth and permissions from `authenticate` / `requirePermission`,
 * and request shapes from the Zod schemas given to `validate()`. Response bodies follow the `{ data }` envelope;
 * their TypeScript DTOs live in `src/shared/dto.ts`.
 */

type Schemas = { body?: ZodType; params?: ZodType; query?: ZodType };
type Handler = { schemas?: Schemas; permissions?: string[]; stack?: Layer[] };
interface Layer {
  handle: Handler;
  mountPath?: string;
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
}
export interface Endpoint {
  method: string;
  path: string;
  auth: boolean;
  permissions: string[];
  schemas: Schemas;
}

/** Every endpoint under `router`, with the auth, permissions and schemas its middleware declares. */
export function listEndpoints(router: unknown, prefix = '', auth = false, permissions: string[] = []): Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const layer of (router as { stack: Layer[] }).stack) {
    const { handle } = layer;
    if (layer.route) {
      const own = layer.route.stack.map((l) => l.handle);
      const required = [...permissions, ...own.flatMap((h) => h.permissions ?? [])];
      const path = `${prefix}${layer.route.path}`.replace(/(.)\/$/, '$1');
      for (const method of Object.keys(layer.route.methods)) {
        endpoints.push({
          method,
          path,
          auth: auth || required.length > 0 || own.includes(authenticate as Handler),
          permissions: required,
          schemas: Object.assign({}, ...own.map((h) => h.schemas ?? {})) as Schemas,
        });
      }
    } else if (handle.stack) {
      endpoints.push(...listEndpoints(handle, prefix + (layer.mountPath ?? ''), auth, permissions));
    } else if (handle === (authenticate as Handler)) {
      auth = true;
    } else if (handle.permissions) {
      permissions = [...permissions, ...handle.permissions];
    }
  }
  return endpoints;
}

const toJson = (schema: ZodType) =>
  z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'openapi-3.0' }) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

function parameters(e: Endpoint, location: 'path' | 'query') {
  const schema = location === 'path' ? e.schemas.params : e.schemas.query;
  const props = schema ? (toJson(schema).properties ?? {}) : {};
  const names = location === 'path' ? [...e.path.matchAll(/:(\w+)/g)].map((m) => m[1]!) : Object.keys(props);
  const required = schema ? (toJson(schema).required ?? []) : [];
  return names.map((name) => ({
    name,
    in: location,
    required: location === 'path' || required.includes(name),
    schema: props[name] ?? { type: 'string' },
  }));
}

const errorCodes = Object.entries(ERROR_CODES)
  .map(([code, { status }]) => `\`${code}\` (${status})`)
  .join(', ');

export function buildOpenApiDocument(apiRouter: unknown) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of listEndpoints(apiRouter)) {
    const path = e.path.replace(/:(\w+)/g, '{$1}');
    const parametersList = [...parameters(e, 'path'), ...parameters(e, 'query')];
    (paths[path] ??= {})[e.method] = {
      tags: [path.split('/')[1] ?? 'root'],
      ...(e.permissions.length > 0 && { description: `Requires ${e.permissions.map((p) => `\`${p}\``).join(' and ')}.` }),
      security: e.auth ? [{ cookieAuth: [] }] : [],
      ...(parametersList.length > 0 && { parameters: parametersList }),
      ...(e.schemas.body && { requestBody: { required: true, content: { 'application/json': { schema: toJson(e.schemas.body) } } } }),
      responses: {
        '2XX': { description: 'Success: `{ "data": … }` (204 has no body).' },
        default: { $ref: '#/components/responses/Error' },
      },
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'SchoolVerse API',
      version: '1.0.0',
      description: [
        'Generated from the running routes and their Zod schemas. Behaviour and ownership rules: `CONTRACTS.md` and `ACADEMIC_CONTRACTS.md` in `backend/src/docs`.',
        '',
        '**Conventions**',
        '- Success: `{ "data": … }`. Error: `{ "error": { "code", "message", "details?", "requestId" } }`; `VALIDATION_FAILED` adds `details.fields` (dotted paths).',
        '- IDs are permanent UUIDs. Labels (names, codes) are presentation only: store `locationId`, never a name.',
        "- The tenant always comes from the signed-in session, never from the request. Another tenant's ids return **404**, not 403.",
        '- Status changes are business operations (`/activate`, `/set-primary` …), never PATCH fields.',
        '',
        `**Error codes:** ${errorCodes}.`,
      ].join('\n'),
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sv_access', description: 'httpOnly access-token cookie set by /auth/login or /auth/signup.' },
      },
      responses: {
        Error: { description: 'Error envelope (see the error codes above).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } } } },
      },
      schemas: {
        ErrorBody: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', enum: Object.keys(ERROR_CODES) },
                message: { type: 'string' },
                details: { type: 'object', additionalProperties: true },
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
