import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { maskKey, parseCurl } from './curl-parser';

export interface ApiKeyRow {
  id: number;
  account: string;
  project: string;
  api_key: string;
  note: string;
  enabled: number;
  disabled_reason: string | null;
  created_at: number;
}

export interface CreateKeyDto {
  curl?: string;
  apiKey?: string;
  account?: string;
  project?: string;
  note?: string;
}

@Injectable()
export class KeysService {
  constructor(private readonly dbs: DatabaseService) {}

  private get db() {
    return this.dbs.db;
  }

  private enabledCache: ApiKeyRow[] | null = null;

  /** Key đang bật, sort theo id — cache trong RAM để việc chọn key không phải gọi DB. */
  enabledKeys(): ApiKeyRow[] {
    return (this.enabledCache ??= this.db.prepare('SELECT * FROM api_keys WHERE enabled = 1 ORDER BY id').all() as ApiKeyRow[]);
  }

  /** Gọi sau mọi thay đổi bảng api_keys (kể cả từ import backup). */
  invalidate() {
    this.enabledCache = null;
  }

  /** Sort theo account để các key cùng account nằm cạnh nhau. */
  listRaw(): ApiKeyRow[] {
    return this.db
      .prepare('SELECT * FROM api_keys ORDER BY account COLLATE NOCASE, project COLLATE NOCASE, id')
      .all() as ApiKeyRow[];
  }

  list() {
    return this.listRaw().map((r) => this.toPublic(r));
  }

  get(id: number): ApiKeyRow {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
    if (!row) throw new NotFoundException(`Key #${id} not found`);
    return row;
  }

  toPublic(r: ApiKeyRow) {
    return {
      id: r.id,
      account: r.account,
      project: r.project,
      keyMasked: maskKey(r.api_key),
      note: r.note,
      enabled: !!r.enabled,
      disabledReason: r.disabled_reason,
      createdAt: r.created_at,
    };
  }

  create(dto: CreateKeyDto) {
    const account = (dto.account || '').trim();
    const project = (dto.project || '').trim();
    if (!account) throw new BadRequestException('account là bắt buộc');
    if (!project) throw new BadRequestException('project là bắt buộc');

    const parsed = parseCurl(dto.apiKey || dto.curl || '');
    if (!parsed.apiKey) throw new BadRequestException('Không tìm thấy API key trong nội dung đã paste');

    const dupKey = this.db.prepare('SELECT account, project FROM api_keys WHERE api_key = ?').get(parsed.apiKey) as
      | { account: string; project: string }
      | undefined;
    if (dupKey) throw new ConflictException(`Key này đã tồn tại (${dupKey.account} / ${dupKey.project})`);

    const dupProject = this.db
      .prepare('SELECT id FROM api_keys WHERE account = ? COLLATE NOCASE AND project = ? COLLATE NOCASE')
      .get(account, project);
    if (dupProject)
      throw new ConflictException(
        `Project "${project}" của "${account}" đã có key. Quota free tier tính theo PROJECT, nhiều key cùng project sẽ dùng chung quota.`,
      );

    const info = this.db
      .prepare('INSERT INTO api_keys (account, project, api_key, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(account, project, parsed.apiKey, (dto.note || '').trim(), Date.now());
    this.invalidate();
    return { key: this.toPublic(this.get(Number(info.lastInsertRowid))), detectedModel: parsed.model };
  }

  update(id: number, dto: { account?: string; project?: string; note?: string; enabled?: boolean }) {
    const cur = this.get(id);
    const account = dto.account !== undefined ? dto.account.trim() : cur.account;
    const project = dto.project !== undefined ? dto.project.trim() : cur.project;
    if (!account || !project) throw new BadRequestException('account/project không được rỗng');
    const enabled = dto.enabled !== undefined ? (dto.enabled ? 1 : 0) : cur.enabled;
    const reason = enabled ? null : dto.enabled === false ? 'Tắt thủ công' : cur.disabled_reason;
    try {
      this.db
        .prepare('UPDATE api_keys SET account=?, project=?, note=?, enabled=?, disabled_reason=? WHERE id=?')
        .run(account, project, dto.note !== undefined ? dto.note.trim() : cur.note, enabled, reason, id);
    } catch (e: any) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new ConflictException('account/project bị trùng');
      throw e;
    }
    this.invalidate();
    return this.toPublic(this.get(id));
  }

  disable(id: number, reason: string) {
    this.db.prepare('UPDATE api_keys SET enabled=0, disabled_reason=? WHERE id=?').run(reason, id);
    this.invalidate();
  }

  remove(id: number) {
    this.get(id);
    this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    this.invalidate();
    return { ok: true };
  }

  /** Kiểm tra key bằng endpoint list models (không tốn quota generate). */
  async test(id: number) {
    const row = this.get(id);
    const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
    const started = Date.now();
    try {
      const res = await fetch(`${base}/v1beta/models?pageSize=1`, {
        headers: { 'x-goog-api-key': row.api_key },
        signal: AbortSignal.timeout(15_000),
      });
      const body: any = await res.json().catch(() => ({}));
      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        error: res.ok ? null : body?.error?.message || res.statusText,
      };
    } catch (e: any) {
      return { ok: false, status: 0, latencyMs: Date.now() - started, error: e?.message || String(e) };
    }
  }
}
