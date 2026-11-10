import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * better-sqlite3 là synchronous: một chuỗi lệnh không có `await` ở giữa sẽ chạy
 * nguyên khối trên event loop -> dùng để "giữ chỗ" quota một cách atomic
 * (chọn key + ghi log pending) mà không cần lock.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly db: Database.Database;

  constructor() {
    const file = resolve(process.env.DB_PATH || './data/gg-studio.db');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        project TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        disabled_reason TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (account, project)
      );

      -- rpm/tpm/rpd: NULL = Unlimited, 0 = không có free tier cho model này
      CREATE TABLE IF NOT EXISTS model_limits (
        model_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        rpm INTEGER,
        tpm INTEGER,
        rpd INTEGER,
        aliases TEXT NOT NULL DEFAULT '',
        capability TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- status: pending | ok | error (tính quota)
      --         rate_limited | client_error | auth_error | network_error (không tính quota)
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        http_status INTEGER,
        error TEXT,
        latency_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_log_key_model_ts ON request_log (key_id, model_id, ts);
      CREATE INDEX IF NOT EXISTS idx_log_ts ON request_log (ts);

      CREATE TABLE IF NOT EXISTS cooldowns (
        key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        until INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (key_id, model_id)
      );

      -- key cấp cho client gọi vào gateway. Xác thực bằng token_hash; token (plaintext) chỉ để admin xem lại,
      -- NULL với key tạo trước khi có cột này. allowed_models: JSON array, [] = mọi model.
      -- daily_limit: số request/ngày key này được gọi, NULL = không giới hạn riêng (chỉ theo pool)
      CREATE TABLE IF NOT EXISTS client_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        token TEXT,
        allowed_models TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        daily_limit INTEGER
      );
    `);
    const cols = this.db.prepare(`PRAGMA table_info(request_log)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'client_id')) this.db.exec('ALTER TABLE request_log ADD COLUMN client_id INTEGER');
    const clientCols = this.db.prepare(`PRAGMA table_info(client_keys)`).all() as { name: string }[];
    if (!clientCols.some((c) => c.name === 'token')) this.db.exec('ALTER TABLE client_keys ADD COLUMN token TEXT');
    if (!clientCols.some((c) => c.name === 'daily_limit')) this.db.exec('ALTER TABLE client_keys ADD COLUMN daily_limit INTEGER');
    // capability sửa tay; '' = tự đoán theo tên/category (xem limits/capability.ts)
    const limitCols = this.db.prepare(`PRAGMA table_info(model_limits)`).all() as { name: string }[];
    if (!limitCols.some((c) => c.name === 'capability'))
      this.db.exec(`ALTER TABLE model_limits ADD COLUMN capability TEXT NOT NULL DEFAULT ''`);
  }

  /** Hook cuối cùng khi tắt app: các service khác đã kịp ghi nốt dữ liệu trong onModuleDestroy. */
  onApplicationShutdown() {
    this.db.close();
  }
}
