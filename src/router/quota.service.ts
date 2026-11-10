import { BeforeApplicationShutdown, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { quotaDayEnd, quotaDayStart } from '../common/time';
import { DatabaseService } from '../db/database.service';
import { ApiKeyRow, KeysService } from '../keys/keys.service';
import { ModelLimit } from '../limits/limits.service';

/** Các trạng thái được tính vào quota local (request đã thực sự tới được model). */
const COUNTED = `('pending','ok','error')`;
const MINUTE = 60_000;
const LOG_RETENTION_MS = 3 * 24 * 3600_000;
/** Chu kỳ ghi log từ RAM xuống DB. Crash thì mất tối đa chừng này số liệu (Google 429 sẽ tự sửa lại). */
const FLUSH_INTERVAL_MS = 200;
const FLUSH_MAX_QUEUE = 1000;

export type LogStatus =
  | 'pending'
  | 'ok'
  | 'error'
  | 'rate_limited'
  | 'client_error'
  | 'auth_error'
  | 'upstream_error'
  | 'network_error';

export interface Usage {
  rpm: number;
  tpm: number;
  rpd: number;
  oldestInMinute: number | null;
}

/** Bộ đếm cho 1 cặp key+model: số request trong ngày + các request trong 60s gần nhất. */
interface Counter {
  day: number;
  rpd: number;
  win: { id: number; ts: number; tokens: number }[];
}

interface LogRow {
  id: number;
  keyId: number;
  modelId: string;
  requestedModel: string;
  ts: number;
  tokens: number;
  status: LogStatus;
  httpStatus: number | null;
  error: string | null;
  latencyMs: number | null;
  clientId: number | null;
  /** còn nằm trong hàng đợi insert, chưa xuống DB */
  queued: boolean;
}

export type ReserveResult =
  | { ok: true; key: ApiKeyRow; logId: number }
  | { ok: false; reason: 'no_keys' | 'exhausted' | 'client_limit'; retryAt: number | null; detail: string[] };

/**
 * Toàn bộ việc CHỌN KEY chạy trong RAM, không có lệnh DB nào trên đường đi của request:
 *  - danh sách key đang bật: cache trong KeysService
 *  - bộ đếm RPM/TPM/RPD và cooldown: Map trong service này, nạp từ DB 1 lần lúc khởi động
 *  - log request: đẩy vào hàng đợi, ghi xuống DB theo lô mỗi 200ms (write-behind)
 * DB (SQLite) chỉ còn vai trò lưu trữ để restart/build lại vẫn lên đúng số liệu.
 */
@Injectable()
export class QuotaService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  /** con trỏ xoay vòng theo từng model */
  private readonly rr = new Map<string, number>();
  private readonly counters = new Map<string, Counter>();
  /** cooldowns[keyId][modelId] */
  private readonly cooldowns = new Map<number, Map<string, { until: number; reason: string }>>();
  /** số request tính quota hôm nay của từng client key (để chặn theo hạn mức riêng) */
  private readonly clientDay = new Map<number, { day: number; n: number }>();
  /** request đang chờ kết quả: logId -> bộ đếm đã giữ chỗ + dòng log */
  private readonly inflight = new Map<number, { c: Counter; row: LogRow }>();
  private dayCache = { start: 0, end: 0 };

  private nextLogId = 1;
  private insertQueue: LogRow[] = [];
  private updateQueue: LogRow[] = [];
  private flushTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;

  constructor(
    private readonly dbs: DatabaseService,
    private readonly keys: KeysService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  onModuleInit() {
    // request treo lại từ lần chạy trước (process bị kill) -> đánh dấu error, vẫn tính quota cho chắc
    this.db.prepare(`UPDATE request_log SET status='error', error='interrupted' WHERE status='pending'`).run();
    this.prune();
    this.loadFromDb();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    this.pruneTimer = setInterval(() => this.prune(), 3600_000);
    this.pruneTimer.unref();
  }

  /** Tắt app: ghi nốt log còn trong hàng đợi (DB chỉ đóng ở onApplicationShutdown, sau hook này). */
  onModuleDestroy() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.flush();
  }

  beforeApplicationShutdown() {
    this.flush();
  }

  prune() {
    const now = Date.now();
    this.db.prepare('DELETE FROM request_log WHERE ts < ?').run(now - LOG_RETENTION_MS);
    this.db.prepare('DELETE FROM cooldowns WHERE until < ?').run(now);
    for (const [keyId, m] of this.cooldowns) {
      for (const [modelId, c] of m) if (c.until < now) m.delete(modelId);
      if (!m.size) this.cooldowns.delete(keyId);
    }
  }

  // ---------------------------------------------------------------- RAM <-> DB

  private day(now: number) {
    if (now < this.dayCache.start || now >= this.dayCache.end)
      this.dayCache = { start: quotaDayStart(now), end: quotaDayEnd(now) };
    return this.dayCache;
  }

  /** Nạp toàn bộ bộ đếm + cooldown từ DB vào RAM (lúc khởi động và sau khi import backup). */
  private loadFromDb() {
    const now = Date.now();
    const day = this.day(now).start;
    this.counters.clear();
    this.cooldowns.clear();
    this.inflight.clear();
    this.clientDay.clear();

    const perClient = this.db
      .prepare(`SELECT client_id AS id, COUNT(*) AS n FROM request_log WHERE ts >= ? AND client_id IS NOT NULL AND status IN ${COUNTED} GROUP BY client_id`)
      .all(day) as { id: number; n: number }[];
    for (const r of perClient) this.clientDay.set(r.id, { day, n: r.n });

    const daily = this.db
      .prepare(`SELECT key_id, model_id, COUNT(*) AS rpd FROM request_log WHERE ts >= ? AND status IN ${COUNTED} GROUP BY key_id, model_id`)
      .all(day) as { key_id: number; model_id: string; rpd: number }[];
    for (const r of daily) this.counters.set(`${r.key_id}|${r.model_id}`, { day, rpd: r.rpd, win: [] });

    const recent = this.db
      .prepare(`SELECT id, key_id, model_id, ts, tokens FROM request_log WHERE ts >= ? AND status IN ${COUNTED} ORDER BY ts`)
      .all(now - MINUTE) as { id: number; key_id: number; model_id: string; ts: number; tokens: number }[];
    for (const r of recent) this.counter(r.key_id, r.model_id, now).win.push({ id: r.id, ts: r.ts, tokens: r.tokens });

    const cds = this.db.prepare('SELECT key_id, model_id, until, reason FROM cooldowns WHERE until > ?').all(now) as {
      key_id: number;
      model_id: string;
      until: number;
      reason: string;
    }[];
    for (const c of cds) this.cooldownMap(c.key_id).set(c.model_id, { until: c.until, reason: c.reason });

    const { maxId } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM request_log').get() as { maxId: number };
    const seq = this.db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='request_log'`).get() as { seq: number } | undefined;
    this.nextLogId = Math.max(maxId, seq?.seq ?? 0) + 1;
  }

  /** Ghi hàng đợi log xuống DB trong 1 transaction. An toàn khi gọi bất cứ lúc nào. */
  flush() {
    if (!this.insertQueue.length && !this.updateQueue.length) return;
    const inserts = this.insertQueue;
    const updates = this.updateQueue;
    this.insertQueue = [];
    this.updateQueue = [];
    for (const r of inserts) r.queued = false;
    const ins = this.db.prepare(
      `INSERT INTO request_log (id, key_id, model_id, requested_model, ts, tokens, status, http_status, error, latency_ms, client_id)
       VALUES (@id, @keyId, @modelId, @requestedModel, @ts, @tokens, @status, @httpStatus, @error, @latencyMs, @clientId)`,
    );
    const upd = this.db.prepare(
      `UPDATE request_log SET status=@status, tokens=@tokens, http_status=@httpStatus, error=@error, latency_ms=@latencyMs WHERE id=@id`,
    );
    const bind = ({ queued, ...r }: LogRow) => r;
    try {
      this.db.transaction(() => {
        for (const r of inserts) ins.run(bind(r));
        for (const r of updates) upd.run(bind(r));
      })();
    } catch {
      // vd key vừa bị xoá trong lúc request đang chạy (vi phạm foreign key) -> ghi từng dòng, bỏ dòng lỗi
      for (const r of inserts) try { ins.run(bind(r)); } catch { /* bỏ */ }
      for (const r of updates) try { upd.run(bind(r)); } catch { /* bỏ */ }
    }
  }

  /** Ghi hết hàng đợi rồi nạp lại RAM từ DB. Gọi sau khi DB bị sửa từ bên ngoài (import backup). */
  resetCounters() {
    this.flush();
    this.loadFromDb();
  }

  // ---------------------------------------------------------------- bộ đếm

  private counter(keyId: number, modelId: string, now: number): Counter {
    const day = this.day(now).start;
    const id = `${keyId}|${modelId}`;
    let c = this.counters.get(id);
    if (!c) this.counters.set(id, (c = { day, rpd: 0, win: [] }));
    else if (c.day !== day) {
      // sang ngày mới (00:00 Pacific): RPD về 0, cửa sổ 60s giữ nguyên
      c.day = day;
      c.rpd = 0;
    }
    const cut = now - MINUTE;
    let drop = 0;
    while (drop < c.win.length && c.win[drop].ts < cut) drop++;
    if (drop) c.win.splice(0, drop);
    return c;
  }

  usage(keyId: number, modelId: string, now = Date.now()): Usage {
    const c = this.counter(keyId, modelId, now);
    let tpm = 0;
    for (const w of c.win) tpm += w.tokens;
    return { rpm: c.win.length, tpm, rpd: c.rpd, oldestInMinute: c.win.length ? c.win[0].ts : null };
  }

  private clientCounter(clientId: number, now: number) {
    const day = this.day(now).start;
    let c = this.clientDay.get(clientId);
    if (!c || c.day !== day) this.clientDay.set(clientId, (c = { day, n: 0 }));
    return c;
  }

  /** Số request tính quota hôm nay của một client key (gồm cả request đang chạy). */
  clientUsed(clientId: number, now = Date.now()) {
    return this.clientCounter(clientId, now).n;
  }

  // ---------------------------------------------------------------- cooldown

  private cooldownMap(keyId: number) {
    let m = this.cooldowns.get(keyId);
    if (!m) this.cooldowns.set(keyId, (m = new Map()));
    return m;
  }

  cooldown(keyId: number, modelId: string, now = Date.now()) {
    const m = this.cooldowns.get(keyId);
    if (!m) return null;
    let best: { until: number; reason: string } | null = null;
    for (const id of [modelId, '*']) {
      const c = m.get(id);
      if (c && c.until > now && (!best || c.until > best.until)) best = c;
    }
    return best;
  }

  setCooldown(keyId: number, modelId: string, until: number, reason: string) {
    const m = this.cooldownMap(keyId);
    const next = { until: Math.max(until, m.get(modelId)?.until ?? 0), reason };
    m.set(modelId, next);
    // ghi DB ngay: chỉ xảy ra khi Google trả lỗi, không nằm trên đường chọn key
    this.db
      .prepare(
        `INSERT INTO cooldowns (key_id, model_id, until, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(key_id, model_id) DO UPDATE SET until=excluded.until, reason=excluded.reason`,
      )
      .run(keyId, modelId, next.until, reason);
  }

  clearCooldown(keyId: number, modelId?: string) {
    if (modelId) {
      this.cooldowns.get(keyId)?.delete(modelId);
      this.db.prepare('DELETE FROM cooldowns WHERE key_id=? AND model_id=?').run(keyId, modelId);
    } else {
      this.cooldowns.delete(keyId);
      this.db.prepare('DELETE FROM cooldowns WHERE key_id=?').run(keyId);
    }
  }

  // ---------------------------------------------------------------- chọn key

  /**
   * Chọn key chia đều (ít dùng nhất, hoà thì xoay vòng), chỉ xét key còn quota, và giữ chỗ luôn.
   * Hàm này KHÔNG gọi DB và không có await -> chạy nguyên khối trên event loop,
   * nên 2 request đồng thời không thể cùng lấy 1 slot cuối.
   */
  reserve(
    limit: ModelLimit,
    requestedModel: string,
    estTokens: number,
    exclude: Set<number>,
    clientId: number | null = null,
    /** hạn mức request/ngày của client key; null = không giới hạn riêng */
    clientLimit: number | null = null,
  ): ReserveResult {
    const now = Date.now();
    // kiểm tra trong cùng khối đồng bộ với việc giữ chỗ -> 2 request đồng thời không cùng lấy slot cuối
    if (clientId != null && clientLimit != null) {
      const used = this.clientCounter(clientId, now).n;
      if (used >= clientLimit)
        return { ok: false, reason: 'client_limit', retryAt: this.day(now).end, detail: [`hết hạn mức ${used}/${clientLimit} request hôm nay`] };
    }
    const keys = this.keys.enabledKeys();
    if (!keys.length) return { ok: false, reason: 'no_keys', retryAt: null, detail: ['Chưa có key nào đang bật'] };

    const n = keys.length;
    const start = (this.rr.get(limit.modelId) ?? 0) % n;
    let retryAt = Infinity;
    const detail: string[] = [];
    let best: { idx: number; key: ApiKeyRow; u: Usage } | null = null;

    // Duyệt theo thứ tự xoay vòng, lọc key còn quota, rồi chọn key ĐÃ DÙNG ÍT NHẤT
    // (RPD hôm nay, rồi RPM phút này). Hoà nhau thì key đứng trước trong vòng xoay thắng.
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const k = keys[idx];
      if (exclude.has(k.id)) continue;
      const label = `${k.account}/${k.project}`;

      const cd = this.cooldown(k.id, limit.modelId, now);
      if (cd) {
        retryAt = Math.min(retryAt, cd.until);
        detail.push(`${label}: cooldown (${cd.reason})`);
        continue;
      }
      const u = this.usage(k.id, limit.modelId, now);
      if (limit.rpd !== null && u.rpd >= limit.rpd) {
        retryAt = Math.min(retryAt, this.day(now).end);
        detail.push(`${label}: hết RPD ${u.rpd}/${limit.rpd}`);
        continue;
      }
      if (limit.rpm !== null && u.rpm >= limit.rpm) {
        retryAt = Math.min(retryAt, (u.oldestInMinute ?? now) + MINUTE);
        detail.push(`${label}: hết RPM ${u.rpm}/${limit.rpm}`);
        continue;
      }
      // request lớn hơn cả TPM thì vẫn cho thử khi phút này chưa dùng gì (để Google quyết định)
      if (limit.tpm !== null && u.tpm > 0 && u.tpm + estTokens > limit.tpm) {
        retryAt = Math.min(retryAt, (u.oldestInMinute ?? now) + MINUTE);
        detail.push(`${label}: hết TPM ${u.tpm}+~${estTokens}/${limit.tpm}`);
        continue;
      }
      if (!best || u.rpd < best.u.rpd || (u.rpd === best.u.rpd && u.rpm < best.u.rpm)) best = { idx, key: k, u };
    }

    if (!best) return { ok: false, reason: 'exhausted', retryAt: Number.isFinite(retryAt) ? retryAt : null, detail };

    const row: LogRow = {
      id: this.nextLogId++,
      keyId: best.key.id,
      modelId: limit.modelId,
      requestedModel,
      ts: now,
      tokens: estTokens,
      status: 'pending',
      httpStatus: null,
      error: null,
      latencyMs: null,
      clientId,
      queued: true,
    };
    const c = this.counter(best.key.id, limit.modelId, now);
    c.rpd++;
    c.win.push({ id: row.id, ts: now, tokens: estTokens });
    if (clientId != null) this.clientCounter(clientId, now).n++;
    this.inflight.set(row.id, { c, row });
    this.insertQueue.push(row);
    if (this.insertQueue.length === FLUSH_MAX_QUEUE) setImmediate(() => this.flush());
    this.rr.set(limit.modelId, best.idx + 1);
    return { ok: true, key: best.key, logId: row.id };
  }

  finalize(
    logId: number,
    p: { status: LogStatus; tokens?: number | null; httpStatus?: number; error?: string | null; latencyMs?: number },
  ) {
    const f = this.inflight.get(logId);
    if (!f) return; // bộ đếm đã bị nạp lại (import backup) trong lúc request đang chạy
    this.inflight.delete(logId);
    const { c, row } = f;

    // Dòng log còn trong hàng đợi insert thì sửa tại chỗ (chỉ 1 lệnh ghi); đã xuống DB thì xếp thêm 1 update.
    row.status = p.status;
    if (p.tokens != null) row.tokens = p.tokens;
    row.httpStatus = p.httpStatus ?? null;
    row.error = p.error ? p.error.slice(0, 500) : null;
    row.latencyMs = p.latencyMs ?? null;
    if (!row.queued) this.updateQueue.push(row);

    // Bộ đếm: request không tính quota thì trả lại chỗ, request ok thì cập nhật token thật
    const i = c.win.findIndex((w) => w.id === logId);
    if (p.status === 'ok' || p.status === 'error') {
      if (i >= 0 && p.tokens != null) c.win[i].tokens = p.tokens;
    } else {
      if (i >= 0) c.win.splice(i, 1);
      if (c.day === this.day(row.ts).start) c.rpd = Math.max(0, c.rpd - 1);
      const cc = row.clientId != null ? this.clientDay.get(row.clientId) : undefined;
      if (cc && cc.day === this.day(row.ts).start) cc.n = Math.max(0, cc.n - 1);
    }
  }

  // ---------------------------------------------------------------- dashboard

  /** Số liệu cho dashboard, lấy thẳng từ RAM: usage[keyId][modelId] */
  snapshot() {
    const now = Date.now();
    const { start, end } = this.day(now);
    const usage: Record<number, Record<string, { rpm: number; tpm: number; rpd: number }>> = {};
    for (const id of this.counters.keys()) {
      const sep = id.indexOf('|');
      const keyId = Number(id.slice(0, sep));
      const modelId = id.slice(sep + 1);
      const u = this.usage(keyId, modelId, now);
      if (u.rpd || u.rpm) (usage[keyId] ||= {})[modelId] = { rpm: u.rpm, tpm: u.tpm, rpd: u.rpd };
    }
    const cooldowns: { keyId: number; modelId: string; until: number; reason: string }[] = [];
    for (const [keyId, m] of this.cooldowns)
      for (const [modelId, c] of m) if (c.until > now) cooldowns.push({ keyId, modelId, until: c.until, reason: c.reason });
    return { now, dayStart: start, dayEnd: end, usage, cooldowns };
  }

  /** Một trang log, mới nhất trước. page bắt đầu từ 1; page vượt quá thì trả trang cuối. */
  logs(page = 1, pageSize = 50) {
    this.flush();
    const size = Math.min(Math.max(Math.floor(pageSize) || 50, 1), 500);
    const { total } = this.db
      .prepare('SELECT COUNT(*) AS total FROM request_log l JOIN api_keys k ON k.id = l.key_id')
      .get() as { total: number };
    const pages = Math.max(1, Math.ceil(total / size));
    const cur = Math.min(Math.max(Math.floor(page) || 1, 1), pages);
    const items = this.db
      .prepare(
        `SELECT l.id, l.ts, l.model_id AS modelId, l.requested_model AS requestedModel, l.tokens, l.status,
                l.http_status AS httpStatus, l.error, l.latency_ms AS latencyMs, k.id AS keyId, k.account, k.project, c.name AS client
         FROM request_log l JOIN api_keys k ON k.id = l.key_id LEFT JOIN client_keys c ON c.id = l.client_id
         ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      )
      .all(size, (cur - 1) * size);
    return { items, total, page: cur, pageSize: size, pages };
  }
}
