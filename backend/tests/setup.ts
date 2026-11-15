import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-test-refresh-secret-0123456789';
process.env.WEB_ORIGIN ??= 'http://localhost:5180';
process.env.LOG_LEVEL = 'silent';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `schoolverse-test-uploads-${process.pid}`);
