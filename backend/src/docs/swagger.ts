import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './openapi';

/** Swagger UI at /api/docs and the raw spec at /api/docs.json, generated from `apiRouter`. */
export function createDocsRouter(apiRouter: Router): Router {
  const router = Router();
  const document = buildOpenApiDocument(apiRouter);
  // Swagger UI needs inline scripts and styles, so relax the CSP for this one path only.
  const docsHeaders = helmet({ contentSecurityPolicy: false });
  router.get('/docs.json', docsHeaders, (_req, res) => res.json(document));
  router.use('/docs', docsHeaders, swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'SchoolVerse API', swaggerOptions: { persistAuthorization: false } }));
  return router;
}
