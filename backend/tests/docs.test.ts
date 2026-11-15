import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from './helpers/factories';
import { loadOpenApiDocument } from '../src/docs/swagger';

type Spec = { paths: Record<string, Record<string, { responses?: unknown }>>; components: { schemas: Record<string, unknown> } };

describe('API documentation (SCH-LOC-14)', () => {
  const spec = loadOpenApiDocument() as unknown as Spec;

  it('parses and documents every Module 1 endpoint', () => {
    const expected: [string, string][] = [
      ['post', '/schools'],
      ['get', '/schools/current'],
      ['get', '/schools/{schoolId}'],
      ['patch', '/schools/{schoolId}'],
      ['post', '/schools/{schoolId}/logo'],
      ['get', '/schools/{schoolId}/identifiers'],
      ['get', '/schools/{schoolId}/locations'],
      ['post', '/schools/{schoolId}/locations'],
      ['get', '/schools/{schoolId}/locations/code-availability'],
      ['get', '/locations/{locationId}'],
      ['patch', '/locations/{locationId}'],
      ['delete', '/locations/{locationId}'],
      ['post', '/locations/{locationId}/activate'],
      ['post', '/locations/{locationId}/deactivate'],
      ['post', '/locations/{locationId}/archive'],
      ['post', '/locations/{locationId}/set-primary'],
      ['get', '/schools/{schoolId}/setup-status'],
      ['patch', '/schools/{schoolId}/setup'],
      ['post', '/schools/{schoolId}/setup/complete'],
      ['get', '/master/school-context'],
      ['get', '/master/locations'],
      ['get', '/master/locations/{locationId}'],
      ['post', '/master/locations/validate'],
      ['get', '/audit'],
    ];
    for (const [method, path] of expected) {
      expect(spec.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(spec.paths[path]![method]!.responses).toBeDefined();
    }
  });

  it('resolves every $ref', () => {
    const text = JSON.stringify(spec);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/(\w+)\/([\w]+)"/g)];
    const components = spec.components as unknown as Record<string, Record<string, unknown>>;
    expect(refs.length).toBeGreaterThan(20);
    for (const [, kind, name] of refs) expect(components[kind!]?.[name!], `#/components/${kind}/${name}`).toBeDefined();
  });

  it('serves Swagger UI and the raw spec without authentication', async () => {
    const ui = await request(app).get('/api/docs/').expect(200);
    expect(ui.text).toContain('swagger-ui');
    const json = await request(app).get('/api/docs.json').expect(200);
    expect(json.body.info.title).toMatch(/SchoolVerse/);
  });

  it('keeps the strict content-security-policy on the API itself', async () => {
    const health = await request(app).get('/api/v1/health').expect(200);
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");
    const docs = await request(app).get('/api/docs/').expect(200);
    expect(docs.headers['content-security-policy']).toBeUndefined();
  });
});
