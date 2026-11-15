import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import { logger } from '../core/logger';

/** Where openapi.yaml may live: next to this file (dev/test), copied beside the bundle (build), or in the source tree. */
function findSpec(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'openapi.yaml'), path.join(here, 'docs', 'openapi.yaml'), path.resolve(process.cwd(), 'src/docs/openapi.yaml')];
  for (const file of candidates) {
    try {
      readFileSync(file);
      return file;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function loadOpenApiDocument(): Record<string, unknown> | null {
  const file = findSpec();
  return file ? (parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
}

/** Swagger UI at /api/docs and the raw spec at /api/docs.json. */
export function createDocsRouter(): Router {
  const router = Router();
  const document = loadOpenApiDocument();
  if (!document) {
    logger.warn('openapi.yaml not found — /api/docs is disabled');
    return router;
  }
  // Swagger UI needs inline scripts and styles, so relax the CSP for this one path only.
  const docsHeaders = helmet({ contentSecurityPolicy: false });
  router.get('/docs.json', docsHeaders, (_req, res) => res.json(document));
  router.use('/docs', docsHeaders, swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'SchoolVerse API', swaggerOptions: { persistAuthorization: false } }));
  return router;
}
