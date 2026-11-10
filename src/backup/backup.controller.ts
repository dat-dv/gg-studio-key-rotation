import { BadRequestException, Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../common/token.guard';
import { DatabaseService } from '../db/database.service';
import { ClientsService, hashToken } from '../clients/clients.service';
import { KeysService } from '../keys/keys.service';
import { isCapability } from '../limits/capability';
import { LimitsService } from '../limits/limits.service';
import { QuotaService } from '../router/quota.service';

interface BackupFile {
  format: 'gg-studio-backup';
  version: 1;
  exportedAt: number;
  keys: { apiKey: string; account: string; project: string; note: string; enabled: boolean; disabledReason: string | null; createdAt: number }[];
  limits: { modelId: string; displayName: string; category: string; rpm: number | null; tpm: number | null; rpd: number | null; aliases: string[]; capabilityOverride?: string | null; sortOrder: number }[];
  /** usage & cooldown tham chiếu key bằng chính apiKey vì id ở 2 máy khác nhau */
  /** key cấp cho client; `token` (key đầy đủ) vắng mặt với key cũ chỉ có hash */
  clients?: { name: string; tokenHash: string; tokenPrefix: string; token?: string | null; allowedModels: string[]; enabled: boolean; createdAt: number; lastUsedAt: number | null; dailyLimit?: number | null }[];
  logs?: { clientHash?: string | null; apiKey: string; modelId: string; requestedModel: string; ts: number; tokens: number; status: string; httpStatus: number | null; error: string | null; latencyMs: number | null }[];
  cooldowns?: { apiKey: string; modelId: string; until: number; reason: string }[];
}

/**
 * Export/import toàn bộ dữ liệu để chuyển từ máy dev lên server.
 * File export chứa API key dạng PLAINTEXT -> chỉ truyền qua kênh an toàn.
 */
@UseGuards(AdminGuard)
@Controller('api/backup')
export class BackupController {
  constructor(
    private readonly dbs: DatabaseService,
    private readonly limits: LimitsService,
    private readonly quota: QuotaService,
    private readonly keys: KeysService,
    private readonly clients: ClientsService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  @Get('export')
  export(@Query('usage') usage: string | undefined, @Res() res: Response) {
    this.quota.flush(); // log còn trong RAM phải xuống DB trước khi export
    const withUsage = usage !== '0';
    const data: BackupFile = {
      format: 'gg-studio-backup',
      version: 1,
      exportedAt: Date.now(),
      keys: this.db
        .prepare(
          `SELECT api_key AS apiKey, account, project, note, enabled, disabled_reason AS disabledReason, created_at AS createdAt
           FROM api_keys ORDER BY id`,
        )
        .all()
        .map((k: any) => ({ ...k, enabled: !!k.enabled })),
      limits: this.limits.list(),
      clients: (this.db.prepare('SELECT * FROM client_keys ORDER BY id').all() as any[]).map((c) => ({
        name: c.name,
        tokenHash: c.token_hash,
        tokenPrefix: c.token_prefix,
        token: c.token ?? null,
        allowedModels: JSON.parse(c.allowed_models || '[]'),
        enabled: !!c.enabled,
        createdAt: c.created_at,
        lastUsedAt: c.last_used_at,
        dailyLimit: c.daily_limit ?? null,
      })),
    };
    if (withUsage) {
      data.logs = this.db
        .prepare(
          `SELECT k.api_key AS apiKey, l.model_id AS modelId, l.requested_model AS requestedModel, l.ts, l.tokens,
                  l.status, l.http_status AS httpStatus, l.error, l.latency_ms AS latencyMs, c.token_hash AS clientHash
           FROM request_log l JOIN api_keys k ON k.id = l.key_id LEFT JOIN client_keys c ON c.id = l.client_id WHERE l.status != 'pending' ORDER BY l.id`,
        )
        .all() as BackupFile['logs'];
      data.cooldowns = this.db
        .prepare(
          `SELECT k.api_key AS apiKey, c.model_id AS modelId, c.until, c.reason
           FROM cooldowns c JOIN api_keys k ON k.id = c.key_id WHERE c.until > ?`,
        )
        .all(Date.now()) as BackupFile['cooldowns'];
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('content-disposition', `attachment; filename="gg-studio-backup-${stamp}.json"`);
    res.json(data);
  }

  /**
   * mode=replace: xoá sạch dữ liệu máy đích rồi nạp -> máy đích Y CHANG file backup.
   * Mặc định (merge), không xoá gì ở máy đích:
   * - key: khớp theo apiKey -> cập nhật nhãn; chưa có -> thêm; trùng (account, project) với key khác -> bỏ qua, báo lại
   * - limits: ghi đè theo modelId (kể cả alias)
   * - logs: bỏ qua dòng đã có (import lại nhiều lần không bị đếm trùng)
   */
  @Post('import')
  import(@Body() body: BackupFile, @Query('mode') mode?: string) {
    if (body?.format !== 'gg-studio-backup' || !Array.isArray(body.keys) || !Array.isArray(body.limits))
      throw new BadRequestException('File không phải backup của gg-studio');

    this.quota.flush(); // tránh trùng id với log đang chờ ghi
    const result = { keysAdded: 0, keysUpdated: 0, keysSkipped: [] as string[], limits: 0, clients: 0, logs: 0, cooldowns: 0 };
    const clientIdByHash = new Map<string, number>();
    const idByKey = new Map<string, number>();

    this.db.transaction(() => {
      if (mode === 'replace') {
        // api_keys xoá kéo theo request_log + cooldowns (ON DELETE CASCADE)
        for (const t of ['request_log', 'cooldowns', 'api_keys', 'client_keys', 'model_limits']) this.db.prepare(`DELETE FROM ${t}`).run();
      }
      const find = this.db.prepare('SELECT id FROM api_keys WHERE api_key = ?');
      const clash = this.db.prepare(
        'SELECT id FROM api_keys WHERE account = ? COLLATE NOCASE AND project = ? COLLATE NOCASE AND api_key != ?',
      );
      for (const k of body.keys) {
        if (!k?.apiKey || !k.account || !k.project) continue;
        if (clash.get(k.account, k.project, k.apiKey)) {
          result.keysSkipped.push(`${k.account} / ${k.project}: máy đích đã có key khác cho project này`);
          continue;
        }
        const existing = find.get(k.apiKey) as { id: number } | undefined;
        if (existing) {
          this.db
            .prepare('UPDATE api_keys SET account=?, project=?, note=?, enabled=?, disabled_reason=? WHERE id=?')
            .run(k.account, k.project, k.note || '', k.enabled ? 1 : 0, k.disabledReason ?? null, existing.id);
          idByKey.set(k.apiKey, existing.id);
          result.keysUpdated++;
        } else {
          const info = this.db
            .prepare(
              'INSERT INTO api_keys (account, project, api_key, note, enabled, disabled_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
            .run(k.account, k.project, k.apiKey, k.note || '', k.enabled ? 1 : 0, k.disabledReason ?? null, k.createdAt || Date.now());
          idByKey.set(k.apiKey, Number(info.lastInsertRowid));
          result.keysAdded++;
        }
      }

      const upLimit = this.db.prepare(
        `INSERT OR REPLACE INTO model_limits (model_id, display_name, category, rpm, tpm, rpd, aliases, capability, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of body.limits) {
        if (!l?.modelId) continue;
        upLimit.run(l.modelId, l.displayName || l.modelId, l.category || '', l.rpm ?? null, l.tpm ?? null, l.rpd ?? null, (l.aliases || []).join(','), isCapability(l.capabilityOverride) ? l.capabilityOverride : '', l.sortOrder ?? 0, Date.now());
        result.limits++;
      }

      const findClient = this.db.prepare('SELECT id FROM client_keys WHERE token_hash = ?');
      for (const c of body.clients || []) {
        if (!c?.tokenHash || !c.name) continue;
        const models = JSON.stringify(Array.isArray(c.allowedModels) ? c.allowedModels : []);
        // chỉ nhận key đầy đủ khi nó khớp đúng hash dùng để xác thực
        const token = typeof c.token === 'string' && hashToken(c.token) === c.tokenHash ? c.token : null;
        // backup cũ không có trường này -> không giới hạn
        const dailyLimit = Number.isInteger(c.dailyLimit) && (c.dailyLimit as number) >= 1 ? c.dailyLimit : null;
        const existing = findClient.get(c.tokenHash) as { id: number } | undefined;
        if (existing) {
          this.db
            .prepare('UPDATE client_keys SET name=?, allowed_models=?, enabled=?, daily_limit=?, token=COALESCE(token, ?) WHERE id=?')
            .run(c.name, models, c.enabled ? 1 : 0, dailyLimit, token, existing.id);
          clientIdByHash.set(c.tokenHash, existing.id);
        } else {
          const info = this.db
            .prepare(
              'INSERT INTO client_keys (name, token_hash, token_prefix, token, allowed_models, enabled, created_at, last_used_at, daily_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(c.name, c.tokenHash, c.tokenPrefix || 'sk-gg-', token, models, c.enabled ? 1 : 0, c.createdAt || Date.now(), c.lastUsedAt ?? null, dailyLimit);
          clientIdByHash.set(c.tokenHash, Number(info.lastInsertRowid));
        }
        result.clients++;
      }

      const hasLog = this.db.prepare('SELECT 1 FROM request_log WHERE key_id=? AND model_id=? AND ts=? AND status=? LIMIT 1');
      const addLog = this.db.prepare(
        `INSERT INTO request_log (key_id, model_id, requested_model, ts, tokens, status, http_status, error, latency_ms, client_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of body.logs || []) {
        const id = idByKey.get(l.apiKey);
        if (!id || hasLog.get(id, l.modelId, l.ts, l.status)) continue;
        addLog.run(id, l.modelId, l.requestedModel || l.modelId, l.ts, l.tokens || 0, l.status, l.httpStatus ?? null, l.error ?? null, l.latencyMs ?? null, (l.clientHash && clientIdByHash.get(l.clientHash)) || null);
        result.logs++;
      }

      const addCd = this.db.prepare(
        `INSERT INTO cooldowns (key_id, model_id, until, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(key_id, model_id) DO UPDATE SET until=MAX(until, excluded.until), reason=excluded.reason`,
      );
      for (const c of body.cooldowns || []) {
        const id = idByKey.get(c.apiKey);
        if (!id || !(c.until > Date.now())) continue;
        addCd.run(id, c.modelId, c.until, c.reason || '');
        result.cooldowns++;
      }
    })();

    this.limits.invalidate();
    this.keys.invalidate();
    this.clients.invalidate();
    this.quota.resetCounters();
    return { mode: mode === 'replace' ? 'replace' : 'merge', ...result };
  }
}
