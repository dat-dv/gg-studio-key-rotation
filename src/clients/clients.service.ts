import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { quotaDayStart } from '../common/time';
import { DatabaseService } from '../db/database.service';
import { LimitsService } from '../limits/limits.service';

/** Ai đang gọi proxy. id = null là master (PROXY_TOKEN) hoặc chế độ mở khi chưa cấu hình gì. */
export interface ClientContext {
  id: number | null;
  name: string;
  /** null = được dùng mọi model */
  allowedModels: string[] | null;
}

interface Row {
  id: number;
  name: string;
  token_hash: string;
  token_prefix: string;
  allowed_models: string;
  enabled: number;
  created_at: number;
  last_used_at: number | null;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Key cấp cho nơi khác gọi vào gateway (khác với API key Google ở tab Keys).
 * Chỉ lưu SHA-256 của token: token đầy đủ chỉ hiện đúng 1 lần lúc tạo.
 */
@Injectable()
export class ClientsService {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly limits: LimitsService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  private parseModels(row: Row): string[] {
    try {
      const v = JSON.parse(row.allowed_models || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private normalizeModels(input: unknown): string[] {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new BadRequestException('allowedModels phải là mảng model id');
    const out = new Set<string>();
    for (const m of input) {
      const l = this.limits.resolve(String(m));
      if (!l) throw new BadRequestException(`Model "${m}" không có trong bảng limits`);
      out.add(l.modelId);
    }
    return [...out];
  }

  /** token_hash -> row, cache trong RAM để xác thực request không phải gọi DB */
  private cache: Map<string, Row> | null = null;

  private byHash() {
    if (!this.cache) {
      this.cache = new Map();
      for (const r of this.db.prepare('SELECT * FROM client_keys').all() as Row[]) this.cache.set(r.token_hash, r);
    }
    return this.cache;
  }

  /** Gọi sau mọi thay đổi bảng client_keys (kể cả từ import backup). */
  invalidate() {
    this.cache = null;
  }

  count() {
    return this.byHash().size;
  }

  list() {
    const today = this.db
      .prepare(
        `SELECT client_id AS id, COUNT(*) AS n, COALESCE(SUM(tokens), 0) AS tokens FROM request_log
         WHERE ts >= ? AND client_id IS NOT NULL AND status IN ('pending','ok','error') GROUP BY client_id`,
      )
      .all(quotaDayStart()) as { id: number; n: number; tokens: number }[];
    const byId = new Map(today.map((t) => [t.id, t]));
    return (this.db.prepare('SELECT * FROM client_keys ORDER BY name COLLATE NOCASE, id').all() as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      tokenPrefix: r.token_prefix,
      allowedModels: this.parseModels(r),
      enabled: !!r.enabled,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      requestsToday: byId.get(r.id)?.n ?? 0,
      tokensToday: byId.get(r.id)?.tokens ?? 0,
    }));
  }

  create(dto: { name?: string; allowedModels?: unknown }) {
    const name = (dto.name || '').trim();
    if (!name) throw new BadRequestException('Tên là bắt buộc');
    const models = this.normalizeModels(dto.allowedModels);
    const token = `sk-gg-${randomBytes(24).toString('base64url')}`;
    const info = this.db
      .prepare('INSERT INTO client_keys (name, token_hash, token_prefix, allowed_models, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, hashToken(token), token.slice(0, 11), JSON.stringify(models), Date.now());
    this.invalidate();
    return { id: Number(info.lastInsertRowid), name, token, allowedModels: models };
  }

  update(id: number, dto: { name?: string; allowedModels?: unknown; enabled?: boolean }) {
    const cur = this.db.prepare('SELECT * FROM client_keys WHERE id=?').get(id) as Row | undefined;
    if (!cur) throw new NotFoundException(`Client key #${id} not found`);
    const name = dto.name !== undefined ? dto.name.trim() : cur.name;
    if (!name) throw new BadRequestException('Tên không được rỗng');
    const models = dto.allowedModels !== undefined ? this.normalizeModels(dto.allowedModels) : this.parseModels(cur);
    const enabled = dto.enabled !== undefined ? (dto.enabled ? 1 : 0) : cur.enabled;
    this.db.prepare('UPDATE client_keys SET name=?, allowed_models=?, enabled=? WHERE id=?').run(name, JSON.stringify(models), enabled, id);
    this.invalidate();
    return this.list().find((c) => c.id === id);
  }

  remove(id: number) {
    this.db.prepare('DELETE FROM client_keys WHERE id=?').run(id);
    this.invalidate();
    return { ok: true };
  }

  /** Trả về context nếu token hợp lệ và đang bật. */
  authenticate(token: string): ClientContext | null {
    const row = this.byHash().get(hashToken(token));
    if (!row || !row.enabled) return null;
    const now = Date.now();
    if (!row.last_used_at || now - row.last_used_at > 30_000) {
      row.last_used_at = now; // ghi DB tối đa 1 lần / 30s cho mỗi client
      this.db.prepare('UPDATE client_keys SET last_used_at=? WHERE id=?').run(now, row.id);
    }
    const models = this.parseModels(row);
    return { id: row.id, name: row.name, allowedModels: models.length ? models : null };
  }
}
