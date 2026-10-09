import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 本地持久化。
 *
 * 优先使用 SQLite（Node 内置 node:sqlite，零原生依赖），
 * 环境不支持时自动退化为带原子写入与备份的 JSON 文件。
 * 两条路径都实现同一个 StoragePort 契约，业务代码完全无感。
 */

export interface PersistentStore {
  load(): Promise<unknown | null>;
  save(data: unknown): Promise<void>;
  clear(): Promise<void>;
  describe(): string;
  engine(): string;
}

const KEY = 'workspace';

class SqliteStore implements PersistentStore {
  private db: unknown;
  private file: string;
  private dir: string;

  constructor(db: unknown, dir: string, file: string) {
    this.db = db;
    this.dir = dir;
    this.file = file;
  }

  describe(): string {
    return this.file;
  }

  engine(): string {
    return 'SQLite（node:sqlite 内置驱动，无原生依赖）';
  }

  private exec(sql: string, params: unknown[] = []): unknown {
    const db = this.db as { prepare: (s: string) => { run: (...p: unknown[]) => unknown; get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] } };
    const stmt = db.prepare(sql);
    return stmt;
  }

  async load(): Promise<unknown | null> {
    void this.dir;
    const stmt = this.exec('SELECT value FROM kv WHERE key = ?') as { get: (k: string) => { value?: string } | undefined };
    const row = stmt.get(KEY);
    if (!row?.value) return null;
    return JSON.parse(row.value) as unknown;
  }

  async save(data: unknown): Promise<void> {
    const stmt = this.exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value') as {
      run: (k: string, v: string) => unknown;
    };
    stmt.run(KEY, JSON.stringify(data));
  }

  async clear(): Promise<void> {
    const stmt = this.exec('DELETE FROM kv WHERE key = ?') as { run: (k: string) => unknown };
    stmt.run(KEY);
  }
}

class JsonFileStore implements PersistentStore {
  constructor(private dir: string, private file: string) {}

  describe(): string {
    return this.file;
  }

  engine(): string {
    return 'JSON 文档（原子写入 + .bak 备份）';
  }

  async load(): Promise<unknown | null> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      return JSON.parse(raw) as unknown;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // 主文件损坏时尝试备份，避免用户数据整体丢失
      try {
        const backup = await fs.readFile(`${this.file}.bak`, 'utf8');
        return JSON.parse(backup) as unknown;
      } catch {
        return null;
      }
    }
  }

  async save(data: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    try {
      await fs.copyFile(this.file, `${this.file}.bak`);
    } catch {
      /* 首次写入时没有主文件，忽略 */
    }
    await fs.rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
    await fs.rm(`${this.file}.bak`, { force: true });
  }
}

export async function createStore(): Promise<PersistentStore> {
  const dir = path.join(app.getPath('userData'), 'data');
  await fs.mkdir(dir, { recursive: true });
  const dbFile = path.join(dir, 'ai-job-partner.db');
  const jsonFile = path.join(dir, 'workspace.json');

  try {
    const sqlite = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => unknown;
      };
    };
    const db = new sqlite.DatabaseSync(dbFile);
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return new SqliteStore(db, dir, dbFile);
  } catch (err) {
    console.warn('[store] node:sqlite 不可用，退化为 JSON 存储：', (err as Error).message);
    return new JsonFileStore(dir, jsonFile);
  }
}
