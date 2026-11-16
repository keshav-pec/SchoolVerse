import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';
import { logger } from '../../core/logger';

/**
 * Private file storage port (PRD §18). Unlike `core/storage`, nothing here has a public URL: files are read back only by
 * the server, after an authorization check or a verified signed link. An S3 adapter can implement the same interface.
 */
export interface PrivateStorage {
  /** Stores bytes under a server-generated random key (never derived from the file name) and returns the key. */
  put(body: Buffer, options?: { folder?: string }): Promise<string>;
  read(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9]+\/[0-9a-f-]{36}$/;

export class LocalPrivateStorage implements PrivateStorage {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolveKey(key: string) {
    if (!SAFE_KEY.test(key)) throw new Error('Unsafe storage key.');
    return path.join(this.rootDir, key);
  }

  async put(body: Buffer, options: { folder?: string } = {}) {
    const key = `${options.folder ?? 'files'}/${randomUUID()}`;
    const full = this.resolveKey(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, { flag: 'wx', mode: 0o600 });
    return key;
  }

  async read(key: string) {
    try {
      return await readFile(this.resolveKey(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async remove(key: string) {
    try {
      await rm(this.resolveKey(key), { force: true });
    } catch (err) {
      logger.warn({ err }, 'Could not remove a private file');
    }
  }
}

export const privateStorage: PrivateStorage = new LocalPrivateStorage(env.PRIVATE_UPLOAD_DIR);
