import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { DEFAULT_LIMITS_RAW } from './default-limits';
import { Capability, inferCapability, isCapability } from './capability';
import { normalizeModelId, parseLimitsTable, unusableReason } from './limits-parser';

export interface ModelLimit {
  modelId: string;
  displayName: string;
  category: string;
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  aliases: string[];
  /** capability đang áp dụng (sửa tay nếu có, không thì tự đoán) */
  capability: Capability;
  /** capability sửa tay; null = tự đoán */
  capabilityOverride: Capability | null;
  /** null = gọi được; ngược lại là lý do (limit 0, nhóm Live API / Agents) */
  unavailableReason: string | null;
  sortOrder: number;
}

interface Row {
  model_id: string;
  display_name: string;
  category: string;
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  aliases: string;
  capability: string;
  sort_order: number;
}

@Injectable()
export class LimitsService implements OnModuleInit {
  private cache: { list: ModelLimit[]; exact: Map<string, ModelLimit>; norm: Map<string, ModelLimit> } | null = null;

  constructor(private readonly dbs: DatabaseService) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit() {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM model_limits').get() as { n: number };
    if (n === 0) this.import(DEFAULT_LIMITS_RAW, 'replace');
  }

  private load() {
    if (this.cache) return this.cache;
    const rows = this.db.prepare('SELECT * FROM model_limits ORDER BY sort_order, display_name').all() as Row[];
    const list = rows.map<ModelLimit>((r) => {
      const override = isCapability(r.capability) ? r.capability : null;
      return {
        modelId: r.model_id,
        displayName: r.display_name,
        category: r.category,
        rpm: r.rpm,
        tpm: r.tpm,
        rpd: r.rpd,
        aliases: r.aliases ? r.aliases.split(',').map((a) => a.trim()).filter(Boolean) : [],
        capability: override ?? inferCapability({ displayName: r.display_name, modelId: r.model_id, category: r.category }),
        capabilityOverride: override,
        unavailableReason: unusableReason({ category: r.category, rpm: r.rpm, tpm: r.tpm, rpd: r.rpd }),
        sortOrder: r.sort_order,
      };
    });
    const exact = new Map<string, ModelLimit>();
    const norm = new Map<string, ModelLimit>();
    for (const l of list) {
      for (const id of [l.modelId, ...l.aliases]) {
        exact.set(id.toLowerCase(), l);
        if (!norm.has(normalizeModelId(id))) norm.set(normalizeModelId(id), l);
      }
    }
    this.cache = { list, exact, norm };
    return this.cache;
  }

  list() {
    return this.load().list;
  }

  /** Gọi sau khi bảng model_limits bị sửa từ bên ngoài service (vd import backup). */
  invalidate() {
    this.cache = null;
  }

  /** Map tên model client gửi lên -> dòng limit (theo id, alias, rồi id đã chuẩn hoá). */
  resolve(model: string): ModelLimit | null {
    const c = this.load();
    const m = model.toLowerCase().replace(/^models\//, '');
    return c.exact.get(m) || c.norm.get(normalizeModelId(m)) || null;
  }

  private upsertStmt() {
    return this.db.prepare(`
      INSERT INTO model_limits (model_id, display_name, category, rpm, tpm, rpd, aliases, sort_order, updated_at)
      VALUES (@modelId, @displayName, @category, @rpm, @tpm, @rpd, @aliases, @sortOrder, @now)
      ON CONFLICT(model_id) DO UPDATE SET
        display_name=excluded.display_name, category=excluded.category,
        rpm=excluded.rpm, tpm=excluded.tpm, rpd=excluded.rpd,
        aliases=CASE WHEN model_limits.aliases = '' THEN excluded.aliases ELSE model_limits.aliases END,
        sort_order=excluded.sort_order, updated_at=excluded.updated_at`);
  }

  /**
   * Nạp mọi model trong bảng AI Studio. Model chưa dùng được (limit 0, nhóm Agents / Live API) vẫn được nạp
   * nhưng xếp xuống cuối và bị đánh dấu; router chặn khi bị gọi. Lịch sử usage (request_log) không bị đụng tới.
   */
  private classify(raw: string) {
    const parsed = parseLimitsTable(raw || '');
    if (!parsed.length) throw new BadRequestException('Không parse được dòng model nào từ nội dung đã paste');
    const withReason = parsed.map((p) => ({ ...p, reason: unusableReason(p) }));
    const ordered = [...withReason.filter((p) => !p.reason), ...withReason.filter((p) => p.reason)];
    return ordered.map((p, i) => ({ ...p, sortOrder: i }));
  }

  /** Xem trước kết quả import mà không ghi gì: model nào dùng được ngay, model nào nạp vào nhưng chưa dùng được. */
  preview(raw: string, mode: 'merge' | 'replace' = 'merge') {
    const rows = this.classify(raw);
    const current = new Map(this.list().map((c) => [c.modelId, c]));
    const incoming = new Set(rows.map((r) => r.modelId));
    // replace: model đang có trong bảng mà bảng mới không có sẽ bị gỡ
    const removed =
      mode === 'replace'
        ? this.list().filter((c) => !incoming.has(c.modelId)).map((c) => ({ modelId: c.modelId, displayName: c.displayName }))
        : [];
    const view = (r: (typeof rows)[number]) => ({
      modelId: r.modelId,
      displayName: r.displayName,
      category: r.category,
      rpm: r.rpm,
      tpm: r.tpm,
      rpd: r.rpd,
      capability: (mode === 'merge' && current.get(r.modelId)?.capabilityOverride) || inferCapability(r),
    });
    return {
      mode,
      usable: rows.filter((r) => !r.reason).map(view),
      unavailable: rows.filter((r) => r.reason).map((r) => ({ ...view(r), reason: r.reason! })),
      removed,
    };
  }

  import(raw: string, mode: 'merge' | 'replace' = 'merge') {
    const rows = this.classify(raw);
    const stmt = this.upsertStmt();
    this.db.transaction(() => {
      if (mode === 'replace') this.db.prepare('DELETE FROM model_limits').run();
      const now = Date.now();
      for (const { reason, ...p } of rows) stmt.run({ ...p, aliases: p.aliases.join(','), now });
    })();
    this.cache = null;
    const unavailable = rows.filter((r) => r.reason).length;
    return { imported: rows.length, usable: rows.length - unavailable, unavailable, mode };
  }

  update(
    modelId: string,
    dto: Partial<Omit<ModelLimit, 'modelId' | 'capabilityOverride' | 'capability'>> & { newModelId?: string; capability?: string | null },
  ) {
    const cur = this.list().find((l) => l.modelId === modelId);
    if (!cur) throw new NotFoundException(`Model ${modelId} not found`);
    const num = (v: unknown, fallback: number | null) =>
      v === undefined ? fallback : v === null || v === '' ? null : Math.max(0, Math.floor(Number(v)));
    const next = {
      modelId: (dto.newModelId || modelId).trim().toLowerCase(),
      displayName: dto.displayName ?? cur.displayName,
      category: dto.category ?? cur.category,
      rpm: num(dto.rpm, cur.rpm),
      tpm: num(dto.tpm, cur.tpm),
      rpd: num(dto.rpd, cur.rpd),
      aliases: (dto.aliases ?? cur.aliases).map((a) => String(a).trim().toLowerCase()).filter(Boolean).join(','),
      // '' / null / 'auto' = bỏ sửa tay, quay về tự đoán
      capability: dto.capability === undefined ? cur.capabilityOverride ?? '' : dto.capability ?? '',
      sortOrder: dto.sortOrder ?? cur.sortOrder,
      now: Date.now(),
    };
    if (next.capability === 'auto') next.capability = '';
    if (next.capability && !isCapability(next.capability))
      throw new BadRequestException(`capability phải là một trong: chat, embedding, tts, image, other (hoặc rỗng = tự đoán)`);
    for (const k of ['rpm', 'tpm', 'rpd'] as const)
      if (next[k] !== null && Number.isNaN(next[k])) throw new BadRequestException(`${k} không hợp lệ`);
    this.db.transaction(() => {
      if (next.modelId !== modelId) {
        this.db.prepare('DELETE FROM model_limits WHERE model_id=?').run(modelId);
        this.db.prepare('UPDATE request_log SET model_id=? WHERE model_id=?').run(next.modelId, modelId);
        this.db.prepare('DELETE FROM cooldowns WHERE model_id=?').run(modelId);
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO model_limits (model_id, display_name, category, rpm, tpm, rpd, aliases, capability, sort_order, updated_at)
           VALUES (@modelId, @displayName, @category, @rpm, @tpm, @rpd, @aliases, @capability, @sortOrder, @now)`,
        )
        .run(next);
    })();
    this.cache = null;
    return this.list().find((l) => l.modelId === next.modelId);
  }

  create(dto: Partial<Omit<ModelLimit, 'capability'>> & { capability?: string | null }) {
    const modelId = (dto.modelId || '').trim().toLowerCase();
    if (!modelId) throw new BadRequestException('modelId là bắt buộc');
    if (this.list().some((l) => l.modelId === modelId)) throw new BadRequestException('modelId đã tồn tại');
    this.db
      .prepare(
        `INSERT INTO model_limits (model_id, display_name, category, rpm, tpm, rpd, aliases, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
      )
      .run(modelId, dto.displayName || modelId, dto.category || '', null, null, null, this.list().length, Date.now());
    this.cache = null;
    return this.update(modelId, { ...dto, newModelId: undefined });
  }

  remove(modelId: string) {
    this.db.prepare('DELETE FROM model_limits WHERE model_id=?').run(modelId);
    this.cache = null;
    return { ok: true };
  }
}
