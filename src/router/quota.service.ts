import { BeforeApplicationShutdown, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { quotaDayEnd, quotaDayStart } from '../common/time';
import { DatabaseService } from '../db/database.service';
import { ApiKeyRow, KeysService } from '../keys/keys.service';
import { ModelLimit } from '../limits/limits.service';
import { RedisService } from '../redis/redis.service';

/** Các trạng thái được tính vào quota (request đã thực sự tới được model). */
const COUNTED = `('pending','ok','error')`;
const MINUTE = 60_000;
const LOG_RETENTION_MS = 3 * 24 * 3600_000;
/** Chu kỳ ghi log xuống DB. Crash thì mất tối đa chừng này dòng LOG; bộ đếm quota nằm ở Redis nên không mất. */
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
  | {
      ok: true;
      key: ApiKeyRow;
      logId: number;
      /** request này là lượt thử dò cho cặp key+model vừa bị 429 */
      probe: boolean;
      /** số request hôm nay của client key, đã tính cả request này; null khi key không có hạn mức riêng */
      clientUsed: number | null;
    }
  | { ok: false; reason: 'no_keys' | 'exhausted' | 'client_limit'; retryAt: number | null; detail: string[] };

/*
 * Key trong Redis (đều có prefix, mặc định "gg:"; <pair> = "<keyId>|<modelId>"):
 *   rpd:<dayStart>:<pair>        số request tính quota trong ngày            (hết hạn sau khi sang ngày)
 *   win:<pair>                   ZSET logId -> ts, các request trong 60s     (TTL 2 phút)
 *   tok:<pair>                   HASH logId -> token của các request đó      (TTL 2 phút)
 *   client:<dayStart>:<clientId> số request tính quota hôm nay của client key
 *   pairs:<dayStart>             SET các pair có số liệu hôm nay (cho dashboard)
 *   cd:<keyId>                   HASH modelId|"*" -> "<until>|<reason>"
 *   strike:<pair>                số lần liên tiếp Google trả 429 cho pair (về 0 khi có request thành công)
 *   probe:<pair>                 logId của request đang đi thử dò cho pair vừa bị 429 (TTL 60s)
 *   rr:<modelId>                 con trỏ xoay vòng
 *   seeded                       đã nạp bộ đếm từ request_log (Redis mới / mất dữ liệu thì nạp lại)
 */

/**
 * Giữ chỗ nguyên tử: kiểm tra hạn mức client, duyệt key theo vòng xoay, bỏ key đang cooldown / hết RPD / RPM / TPM,
 * chọn key ĐÃ DÙNG ÍT NHẤT rồi cộng bộ đếm ngay. Pair vừa bị 429 (còn strike) mà đã hết cooldown thì chỉ cho MỘT
 * request đi thử dò; các request khác bỏ qua pair đó cho tới khi request dò có kết quả. Cả đoạn chạy trong 1 script nên request (kể cả từ instance khác)
 * tới sau luôn thấy số của request tới trước.
 * ARGV: prefix, now, dayStart, dayEnd, model, estTokens, logId, rpm, tpm, rpd, clientId, clientLimit, rồi (keyId, excluded)*
 */
const LUA_RESERVE = `
local P = ARGV[1]
local now = tonumber(ARGV[2])
local dayStart = ARGV[3]
local dayEnd = tonumber(ARGV[4])
local model = ARGV[5]
local est = tonumber(ARGV[6])
local logId = ARGV[7]
local rpm, tpm, rpd = tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10])
local clientId = ARGV[11]
local clientLimit = tonumber(ARGV[12])
local BASE = 12
local n = (#ARGV - BASE) / 2
local dayTtl = math.floor(dayEnd / 1000) + 3600
local cut = '(' .. string.format('%d', now - 60000)

if clientId ~= '' and clientLimit then
  local used = tonumber(redis.call('GET', P .. 'client:' .. dayStart .. ':' .. clientId) or '0')
  if used >= clientLimit then return {0, 'client_limit', tostring(used)} end
end

local start = tonumber(redis.call('GET', P .. 'rr:' .. model) or '0') % n
local retryAt = -1
local function retry(t) if retryAt < 0 or t < retryAt then retryAt = t end end
local detail = {}
local bestIdx, bestRpd, bestRpm, bestProbing = -1, 0, 0, false

for i = 0, n - 1 do
  local idx = (start + i) % n
  local keyId = ARGV[BASE + 1 + idx * 2]
  if ARGV[BASE + 2 + idx * 2] ~= '1' then
    local pair = keyId .. '|' .. model
    local cdKey = P .. 'cd:' .. keyId
    local cdUntil, cdReason = 0, ''
    for _, f in ipairs({model, '*'}) do
      local v = redis.call('HGET', cdKey, f)
      if v then
        local sep = string.find(v, '|', 1, true)
        local u = tonumber(string.sub(v, 1, sep - 1))
        if u > now then
          if u > cdUntil then cdUntil = u; cdReason = string.sub(v, sep + 1) end
        else
          redis.call('HDEL', cdKey, f)
        end
      end
    end
    local probing = false
    if cdUntil == 0 then probing = redis.call('EXISTS', P .. 'strike:' .. pair) == 1 end
    if cdUntil > 0 then
      retry(cdUntil)
      detail[#detail + 1] = {idx, 'cooldown', cdReason}
    elseif probing and redis.call('EXISTS', P .. 'probe:' .. pair) == 1 then
      retry(now + 2000)
      detail[#detail + 1] = {idx, 'probe', ''}
    else
      local wk, tk = P .. 'win:' .. pair, P .. 'tok:' .. pair
      local old = redis.call('ZRANGEBYSCORE', wk, '-inf', cut)
      if #old > 0 then
        redis.call('ZREMRANGEBYSCORE', wk, '-inf', cut)
        redis.call('HDEL', tk, unpack(old))
      end
      local uRpd = tonumber(redis.call('GET', P .. 'rpd:' .. dayStart .. ':' .. pair) or '0')
      local uRpm = redis.call('ZCARD', wk)
      local uTpm = 0
      for _, t in ipairs(redis.call('HVALS', tk)) do uTpm = uTpm + tonumber(t) end
      local oldest = now
      local first = redis.call('ZRANGE', wk, 0, 0, 'WITHSCORES')
      if first[2] then oldest = tonumber(first[2]) end
      if rpd and uRpd >= rpd then
        retry(dayEnd)
        detail[#detail + 1] = {idx, 'rpd', tostring(uRpd)}
      elseif rpm and uRpm >= rpm then
        retry(oldest + 60000)
        detail[#detail + 1] = {idx, 'rpm', tostring(uRpm)}
      elseif tpm and uTpm > 0 and uTpm + est > tpm then
        -- request lon hon ca TPM van duoc thu khi phut nay chua dung gi (de Google quyet dinh)
        retry(oldest + 60000)
        detail[#detail + 1] = {idx, 'tpm', tostring(uTpm)}
      elseif bestIdx < 0 or uRpd < bestRpd or (uRpd == bestRpd and uRpm < bestRpm) then
        bestIdx, bestRpd, bestRpm, bestProbing = idx, uRpd, uRpm, probing
      end
    end
  end
end

if bestIdx < 0 then return {0, 'exhausted', string.format('%d', retryAt), detail} end

local keyId = ARGV[BASE + 1 + bestIdx * 2]
local pair = keyId .. '|' .. model
local rk = P .. 'rpd:' .. dayStart .. ':' .. pair
redis.call('INCR', rk)
redis.call('EXPIREAT', rk, dayTtl)
redis.call('ZADD', P .. 'win:' .. pair, now, logId)
redis.call('HSET', P .. 'tok:' .. pair, logId, est)
redis.call('PEXPIRE', P .. 'win:' .. pair, 120000)
redis.call('PEXPIRE', P .. 'tok:' .. pair, 120000)
redis.call('SADD', P .. 'pairs:' .. dayStart, pair)
redis.call('EXPIREAT', P .. 'pairs:' .. dayStart, dayTtl)
local clientUsed = -1
if clientId ~= '' then
  local ck = P .. 'client:' .. dayStart .. ':' .. clientId
  clientUsed = redis.call('INCR', ck)
  redis.call('EXPIREAT', ck, dayTtl)
end
redis.call('SET', P .. 'rr:' .. model, bestIdx + 1, 'EX', 172800)
if bestProbing then
  redis.call('SET', P .. 'probe:' .. pair, logId, 'PX', 60000)
  return {1, bestIdx, 1, clientUsed}
end
return {1, bestIdx, 0, clientUsed}
`;

/**
 * Chốt 1 request. counted=1 (ok/error): giữ chỗ, cập nhật token thật. Ngược lại (Google từ chối, lỗi mạng...):
 * trả lại chỗ. ARGV: prefix, pair, dayStart (của lúc giữ chỗ), logId, counted, tokens, clientId, ok
 * ok=1 (Google trả 200): xoá chuỗi 429 liên tiếp của pair.
 */
const LUA_FINALIZE = `
local P, pair, day, logId, counted, tokens, clientId = ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7]
local tk = P .. 'tok:' .. pair
if redis.call('GET', P .. 'probe:' .. pair) == logId then redis.call('DEL', P .. 'probe:' .. pair) end
if ARGV[8] == '1' then redis.call('DEL', P .. 'strike:' .. pair) end
if counted == '1' then
  if tokens ~= '' and redis.call('HEXISTS', tk, logId) == 1 then redis.call('HSET', tk, logId, tokens) end
  return 1
end
redis.call('ZREM', P .. 'win:' .. pair, logId)
redis.call('HDEL', tk, logId)
local rk = P .. 'rpd:' .. day .. ':' .. pair
if tonumber(redis.call('GET', rk) or '0') > 0 then redis.call('DECR', rk) end
if clientId ~= '' then
  local ck = P .. 'client:' .. day .. ':' .. clientId
  if tonumber(redis.call('GET', ck) or '0') > 0 then redis.call('DECR', ck) end
end
return 0
`;

/** Đặt cooldown, không bao giờ rút ngắn cooldown đang có. ARGV: prefix, keyId, modelId, until, reason, now */
const LUA_COOLDOWN = `
local k = ARGV[1] .. 'cd:' .. ARGV[2]
local untilTs, now = tonumber(ARGV[4]), tonumber(ARGV[6])
local cur = redis.call('HGET', k, ARGV[3])
if cur then
  local u = tonumber(string.sub(cur, 1, string.find(cur, '|', 1, true) - 1))
  if u > untilTs then untilTs = u end
end
redis.call('HSET', k, ARGV[3], string.format('%d', untilTs) .. '|' .. ARGV[5])
local need = untilTs - now + 60000
if redis.call('PTTL', k) < need then redis.call('PEXPIRE', k, need) end
return 1
`;

/**
 * Google trả 429 mà không nói rõ quota nào: khoá pair lâu dần. Lần đầu khoá base, mỗi lần 429 liên tiếp sau đó
 * gấp đôi, tối đa cap. Pair đang bị khoá thì KHÔNG tính thêm lần (các request đồng thời đã lỡ gửi đi cùng nhận 429
 * chỉ tính là 1 lần). ARGV: prefix, keyId, modelId, now, baseMs, capMs, reason -> {until, số lần liên tiếp}
 */
const LUA_BACKOFF = `
local P, keyId, model = ARGV[1], ARGV[2], ARGV[3]
local now, base, cap = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local ck = P .. 'cd:' .. keyId
local sk = P .. 'strike:' .. keyId .. '|' .. model
local cur = redis.call('HGET', ck, model)
if cur then
  local u = tonumber(string.sub(cur, 1, string.find(cur, '|', 1, true) - 1))
  if u > now then return {string.format('%d', u), tonumber(redis.call('GET', sk) or '1')} end
end
local n = redis.call('INCR', sk)
local dur = base
for i = 2, n do
  dur = dur * 2
  if dur >= cap then dur = math.max(cap, base); break end
end
local untilTs = now + dur
redis.call('PEXPIRE', sk, dur * 2 + 600000)
local reason = ARGV[7]
if n > 1 then reason = reason .. ' (lần ' .. n .. ' liên tiếp)' end
redis.call('HSET', ck, model, string.format('%d', untilTs) .. '|' .. reason)
local need = dur + 60000
if redis.call('PTTL', ck) < need then redis.call('PEXPIRE', ck, need) end
return {string.format('%d', untilTs), n}
`;

/** Số liệu dashboard của mọi pair có hoạt động hôm nay. ARGV: prefix, now, dayStart -> {pair, rpd, rpm, tpm}* */
const LUA_SNAPSHOT = `
local P, now, day = ARGV[1], tonumber(ARGV[2]), ARGV[3]
local cut = '(' .. string.format('%d', now - 60000)
local out = {}
for _, pair in ipairs(redis.call('SMEMBERS', P .. 'pairs:' .. day)) do
  local wk, tk = P .. 'win:' .. pair, P .. 'tok:' .. pair
  local old = redis.call('ZRANGEBYSCORE', wk, '-inf', cut)
  if #old > 0 then
    redis.call('ZREMRANGEBYSCORE', wk, '-inf', cut)
    redis.call('HDEL', tk, unpack(old))
  end
  local tpm = 0
  for _, t in ipairs(redis.call('HVALS', tk)) do tpm = tpm + tonumber(t) end
  out[#out + 1] = {pair, redis.call('GET', P .. 'rpd:' .. day .. ':' .. pair) or '0', redis.call('ZCARD', wk), tostring(tpm)}
end
return out
`;

/**
 * Chỉ ĐỌC (không dọn cửa sổ, không cộng gì): số liệu để client tự xem quota còn lại.
 * ARGV: prefix, now, dayStart, clientId ('' = bỏ qua), m, modelId * m, keyId * n
 * -> {clientUsed ('' nếu không hỏi), {keyIdx, modelIdx, rpd, rpm, "<until>|<reason>" | ''}*} (idx bắt đầu từ 0)
 */
const LUA_REMAINING = `
local P, now, day, clientId = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4]
local m = tonumber(ARGV[5])
local BASE = 5
local from = '(' .. string.format('%d', now - 60000)
local function active(v)
  if not v then return nil end
  local sep = string.find(v, '|', 1, true)
  if tonumber(string.sub(v, 1, sep - 1)) > now then return v end
  return nil
end
local function untilOf(v) return tonumber(string.sub(v, 1, string.find(v, '|', 1, true) - 1)) end
local out = {}
for ki = BASE + m + 1, #ARGV do
  local keyId = ARGV[ki]
  local cdKey = P .. 'cd:' .. keyId
  local all = active(redis.call('HGET', cdKey, '*'))
  for mi = 1, m do
    local model = ARGV[BASE + mi]
    local pair = keyId .. '|' .. model
    local cd = active(redis.call('HGET', cdKey, model))
    if all and (not cd or untilOf(all) > untilOf(cd)) then cd = all end
    out[#out + 1] = {
      ki - BASE - m - 1,
      mi - 1,
      redis.call('GET', P .. 'rpd:' .. day .. ':' .. pair) or '0',
      redis.call('ZCOUNT', P .. 'win:' .. pair, from, '+inf'),
      cd or '',
    }
  end
end
local used = ''
if clientId ~= '' then used = redis.call('GET', P .. 'client:' .. day .. ':' .. clientId) or '0' end
return {used, out}
`;

/** Quota còn lại của 1 model trên toàn pool. null = không giới hạn (bảng limits để trống). */
export interface ModelRemaining {
  limit: ModelLimit;
  usedToday: number;
  remainingToday: number | null;
  remainingThisMinute: number | null;
  keys: { enabled: number; available: number; coolingDown: number; nextAvailableAt: number | null };
  /** model không gọi được: limit 0, nhóm Live API / Agents */
  unavailableReason: string | null;
}

type Scripts = {
  ggRemaining(...args: (string | number)[]): Promise<[string, [number, number, string, number, string][]]>;
  ggReserve(...args: (string | number)[]): Promise<[1, number, number, number] | [0, 'client_limit', string] | [0, 'exhausted', string, [number, string, string][]]>;
  ggFinalize(...args: (string | number)[]): Promise<number>;
  ggCooldown(...args: (string | number)[]): Promise<number>;
  ggBackoff(...args: (string | number)[]): Promise<[string, number]>;
  ggSnapshot(...args: (string | number)[]): Promise<[string, string, number, string][]>;
};

/**
 * Trạng thái quota nằm hết ở Redis, không giữ trong RAM của process và không có lệnh SQL nào trên đường đi của request:
 *  - bộ đếm RPM/TPM/RPD, hạn mức client, cooldown, con trỏ xoay vòng: Redis, đọc + cộng trong 1 script Lua (nguyên tử)
 *  - danh sách key đang bật: cache trong KeysService
 *  - log request: hàng đợi nhỏ, ghi xuống SQLite theo lô mỗi 200ms (write-behind) để trang Logs / thống kê đọc
 * RAM của process chỉ còn các request ĐANG chạy (logId -> dòng log) và hàng đợi log chưa ghi.
 */
@Injectable()
export class QuotaService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly log = new Logger('Quota');
  /** request đang chờ kết quả: logId -> chỗ đã giữ + dòng log */
  private readonly inflight = new Map<number, { pair: string; day: number; row: LogRow }>();
  private dayCache = { start: 0, end: 0 };

  private nextLogId = 1;
  private insertQueue: LogRow[] = [];
  private updateQueue: LogRow[] = [];
  private flushTimer?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;

  constructor(
    private readonly dbs: DatabaseService,
    private readonly keys: KeysService,
    private readonly redis: RedisService,
  ) {
    const c = this.redis.client;
    c.defineCommand('ggReserve', { numberOfKeys: 0, lua: LUA_RESERVE });
    c.defineCommand('ggFinalize', { numberOfKeys: 0, lua: LUA_FINALIZE });
    c.defineCommand('ggCooldown', { numberOfKeys: 0, lua: LUA_COOLDOWN });
    c.defineCommand('ggBackoff', { numberOfKeys: 0, lua: LUA_BACKOFF });
    c.defineCommand('ggSnapshot', { numberOfKeys: 0, lua: LUA_SNAPSHOT });
    c.defineCommand('ggRemaining', { numberOfKeys: 0, lua: LUA_REMAINING });
  }

  private get db() {
    return this.dbs.db;
  }
  private get r() {
    return this.redis.client;
  }
  private get scripts() {
    return this.redis.client as unknown as Scripts;
  }
  private get P() {
    return this.redis.prefix;
  }

  async onModuleInit() {
    await this.redis.ready();
    // request treo lại từ lần chạy trước (process bị kill) -> đánh dấu error, vẫn tính quota cho chắc
    this.db.prepare(`UPDATE request_log SET status='error', error='interrupted' WHERE status='pending'`).run();
    this.prune();
    this.syncLogId();
    if (!(await this.r.exists(this.P + 'seeded'))) await this.seedFromDb();
    await this.migrateLegacyCooldowns();
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
    this.db.prepare('DELETE FROM request_log WHERE ts < ?').run(Date.now() - LOG_RETENTION_MS);
  }

  // ---------------------------------------------------------------- Redis <-> DB

  private day(now: number) {
    if (now < this.dayCache.start || now >= this.dayCache.end)
      this.dayCache = { start: quotaDayStart(now), end: quotaDayEnd(now) };
    return this.dayCache;
  }

  private syncLogId() {
    const { maxId } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM request_log').get() as { maxId: number };
    const seq = this.db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='request_log'`).get() as { seq: number } | undefined;
    this.nextLogId = Math.max(this.nextLogId, maxId + 1, (seq?.seq ?? 0) + 1);
  }

  /**
   * Dựng lại bộ đếm trong Redis từ request_log. Chỉ chạy khi Redis chưa có số liệu (lần đầu chuyển sang Redis,
   * Redis bị xoá trắng) và sau khi import backup; bình thường Redis tự là nguồn số liệu.
   */
  private async seedFromDb() {
    const now = Date.now();
    const { start, end } = this.day(now);
    const ttl = Math.floor(end / 1000) + 3600;
    const P = this.P;
    const pipe = this.r.pipeline();

    const perClient = this.db
      .prepare(`SELECT client_id AS id, COUNT(*) AS n FROM request_log WHERE ts >= ? AND client_id IS NOT NULL AND status IN ${COUNTED} GROUP BY client_id`)
      .all(start) as { id: number; n: number }[];
    for (const c of perClient) pipe.set(`${P}client:${start}:${c.id}`, c.n, 'EXAT', ttl);

    const daily = this.db
      .prepare(`SELECT key_id, model_id, COUNT(*) AS rpd FROM request_log WHERE ts >= ? AND status IN ${COUNTED} GROUP BY key_id, model_id`)
      .all(start) as { key_id: number; model_id: string; rpd: number }[];
    for (const d of daily) {
      const pair = `${d.key_id}|${d.model_id}`;
      pipe.set(`${P}rpd:${start}:${pair}`, d.rpd, 'EXAT', ttl);
      pipe.sadd(`${P}pairs:${start}`, pair);
    }
    if (daily.length) pipe.expireat(`${P}pairs:${start}`, ttl);

    const recent = this.db
      .prepare(`SELECT id, key_id, model_id, ts, tokens FROM request_log WHERE ts >= ? AND status IN ${COUNTED} ORDER BY ts`)
      .all(now - MINUTE) as { id: number; key_id: number; model_id: string; ts: number; tokens: number }[];
    for (const w of recent) {
      const pair = `${w.key_id}|${w.model_id}`;
      pipe.zadd(`${P}win:${pair}`, w.ts, String(w.id));
      pipe.hset(`${P}tok:${pair}`, String(w.id), w.tokens);
      pipe.pexpire(`${P}win:${pair}`, 2 * MINUTE);
      pipe.pexpire(`${P}tok:${pair}`, 2 * MINUTE);
      pipe.sadd(`${P}pairs:${start}`, pair);
    }
    pipe.set(`${P}seeded`, String(now), 'EX', 7 * 86400);
    await pipe.exec();
    this.log.log(`Nạp bộ đếm vào Redis từ request_log: ${daily.length} cặp key+model, ${perClient.length} client`);
  }

  /** Cooldown từng lưu trong SQLite (bản trước khi dùng Redis, hoặc vừa import backup) -> chuyển sang Redis rồi xoá. */
  private async migrateLegacyCooldowns() {
    const rows = this.db.prepare('SELECT key_id, model_id, until, reason FROM cooldowns WHERE until > ?').all(Date.now()) as {
      key_id: number;
      model_id: string;
      until: number;
      reason: string;
    }[];
    for (const c of rows) await this.setCooldown(c.key_id, c.model_id, c.until, c.reason);
    this.db.prepare('DELETE FROM cooldowns').run();
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


  /**
   * Gọi sau khi DB bị sửa từ bên ngoài (import backup): ghi hết hàng đợi log, xoá bộ đếm trong Redis rồi dựng lại
   * từ request_log. Cooldown trong Redis giữ nguyên trừ khi wipeCooldowns (import kiểu replace).
   */
  async resetCounters(wipeCooldowns = false) {
    this.flush();
    this.inflight.clear();
    const patterns = ['rpd:*', 'win:*', 'tok:*', 'client:*', 'pairs:*', 'rr:*', ...(wipeCooldowns ? ['cd:*', 'strike:*', 'probe:*'] : [])];
    for (const p of patterns) {
      const keys = await this.redis.scan(p);
      for (let i = 0; i < keys.length; i += 500) await this.r.del(...keys.slice(i, i + 500));
    }
    this.syncLogId();
    await this.seedFromDb();
    await this.migrateLegacyCooldowns();
  }

  // ---------------------------------------------------------------- cooldown

  /** Không ném lỗi: cooldown chỉ là tối ưu, Redis trục trặc thì request sau sẽ bị Google từ chối lại và đặt lại. */
  async setCooldown(keyId: number, modelId: string, until: number, reason: string) {
    try {
      await this.scripts.ggCooldown(this.P, keyId, modelId, Math.floor(until), reason.replace(/\s+/g, ' ').slice(0, 300), Date.now());
    } catch (e: any) {
      this.log.error(`setCooldown #${keyId} ${modelId}: ${e?.message || e}`);
    }
  }

  /**
   * Google trả 429 không kèm loại quota: khoá cặp key+model lâu dần (base, 2x, 4x... tối đa capMs) cho tới khi
   * có request thành công. Trả về thời điểm hết khoá và số lần 429 liên tiếp. Không ném lỗi.
   */
  async backoff(keyId: number, modelId: string, baseMs: number, capMs: number, reason: string) {
    const now = Date.now();
    try {
      const [until, strikes] = await this.scripts.ggBackoff(this.P, keyId, modelId, now, Math.floor(baseMs), Math.floor(capMs), reason.replace(/\s+/g, ' ').slice(0, 200));
      return { until: Number(until), strikes };
    } catch (e: any) {
      this.log.error(`backoff #${keyId} ${modelId}: ${e?.message || e}`);
      return { until: now + baseMs, strikes: 1 };
    }
  }

  /**
   * Lượt thử dò vừa được Google nhận (200): mở lại cặp key+model ngay, không chờ response chạy xong
   * (response stream có thể kéo dài cả phút). Không ném lỗi.
   */
  async probeSucceeded(keyId: number, modelId: string) {
    try {
      await this.r.del(`${this.P}strike:${keyId}|${modelId}`, `${this.P}probe:${keyId}|${modelId}`);
    } catch (e: any) {
      this.log.error(`probeSucceeded #${keyId} ${modelId}: ${e?.message || e}`);
    }
  }

  /** Bỏ cooldown (nút trên tab Quota) và xoá luôn chuỗi 429 liên tiếp để lần sau tính lại từ đầu. */
  async clearCooldown(keyId: number, modelId?: string) {
    if (modelId) {
      await this.r.hdel(`${this.P}cd:${keyId}`, modelId);
      await this.r.del(`${this.P}strike:${keyId}|${modelId}`, `${this.P}probe:${keyId}|${modelId}`);
    } else {
      const extra = [...(await this.redis.scan(`strike:${keyId}|*`)), ...(await this.redis.scan(`probe:${keyId}|*`))];
      await this.r.del(`${this.P}cd:${keyId}`, ...extra);
    }
  }

  /** Bỏ cooldown của 1 model trên mọi key (model bị đổi id / sửa ở tab Limits). */
  async clearModelCooldowns(modelId: string) {
    const keys = await this.redis.scan('cd:*');
    if (!keys.length) return;
    const pipe = this.r.pipeline();
    for (const k of keys) pipe.hdel(k, modelId);
    for (const k of await this.redis.scan(`strike:*|${modelId}`)) pipe.del(k);
    await pipe.exec();
  }

  /** Mọi cooldown còn hiệu lực (dashboard, export backup). */
  async listCooldowns(now = Date.now()) {
    const out: { keyId: number; modelId: string; until: number; reason: string }[] = [];
    const keys = await this.redis.scan('cd:*');
    if (!keys.length) return out;
    const pipe = this.r.pipeline();
    for (const k of keys) pipe.hgetall(k);
    const res = (await pipe.exec()) ?? [];
    keys.forEach((k, i) => {
      const keyId = Number(k.slice(k.lastIndexOf(':') + 1));
      for (const [modelId, v] of Object.entries((res[i]?.[1] as Record<string, string>) || {})) {
        const sep = v.indexOf('|');
        const until = Number(v.slice(0, sep));
        if (until > now) out.push({ keyId, modelId, until, reason: v.slice(sep + 1) });
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- chọn key

  /**
   * Chọn key chia đều (ít dùng nhất, hoà thì xoay vòng), chỉ xét key còn quota, và giữ chỗ luôn.
   * Việc kiểm tra + cộng bộ đếm chạy trong 1 script Lua trên Redis nên 2 request đồng thời
   * (kể cả ở 2 instance) không thể cùng lấy 1 slot cuối. Redis lỗi -> ném ra, router trả 503.
   */
  async reserve(
    limit: ModelLimit,
    requestedModel: string,
    estTokens: number,
    exclude: Set<number>,
    clientId: number | null = null,
    /** hạn mức request/ngày của client key; null = không giới hạn riêng */
    clientLimit: number | null = null,
  ): Promise<ReserveResult> {
    const now = Date.now();
    const { start, end } = this.day(now);
    const keys = this.keys.enabledKeys();
    if (!keys.length) return { ok: false, reason: 'no_keys', retryAt: null, detail: ['Chưa có key nào đang bật'] };

    const logId = this.nextLogId++;
    const num = (v: number | null) => (v === null ? '' : v);
    const res = await this.scripts.ggReserve(
      this.P,
      now,
      start,
      end,
      limit.modelId,
      estTokens,
      logId,
      num(limit.rpm),
      num(limit.tpm),
      num(limit.rpd),
      clientId != null && clientLimit != null ? clientId : '',
      num(clientLimit),
      ...keys.flatMap((k) => [k.id, exclude.has(k.id) ? 1 : 0]),
    );

    if (res[0] === 0) {
      if (res[1] === 'client_limit')
        return { ok: false, reason: 'client_limit', retryAt: end, detail: [`hết hạn mức ${res[2]}/${clientLimit} request hôm nay`] };
      const retryAt = Number(res[2]);
      const detail = res[3].map(([idx, kind, v]) => {
        const k = keys[idx];
        const label = `${k.account}/${k.project}`;
        if (kind === 'cooldown') return `${label}: cooldown (${v})`;
        if (kind === 'probe') return `${label}: đang thử dò lại sau 429`;
        if (kind === 'rpd') return `${label}: hết RPD ${v}/${limit.rpd}`;
        if (kind === 'rpm') return `${label}: hết RPM ${v}/${limit.rpm}`;
        return `${label}: hết TPM ${v}+~${estTokens}/${limit.tpm}`;
      });
      return { ok: false, reason: 'exhausted', retryAt: retryAt > 0 ? retryAt : null, detail };
    }

    const key = keys[res[1]];
    const row: LogRow = {
      id: logId,
      keyId: key.id,
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
    this.inflight.set(logId, { pair: `${key.id}|${limit.modelId}`, day: start, row });
    this.insertQueue.push(row);
    if (this.insertQueue.length === FLUSH_MAX_QUEUE) setImmediate(() => this.flush());
    return { ok: true, key, logId, probe: res[2] === 1, clientUsed: res[3] >= 0 ? res[3] : null };
  }

  /**
   * Quota còn lại của các model trên toàn pool, cho client tự xem (GET /v1/quota). Chỉ đọc, không tốn quota.
   * Là ước lượng local: request gọi thẳng Google bằng cùng key thì gateway không đếm được.
   *  - key đang cooldown tới hết ngày (429 theo ngày): còn 0
   *  - key đang cooldown ngắn: vẫn tính phần RPD còn lại, nhưng không tính vào số gọi được trong phút này
   * clientId: client key có hạn mức riêng thì đọc luôn bộ đếm của nó (Redis), null = bỏ qua.
   */
  async remaining(models: ModelLimit[], clientId: number | null, now = Date.now()) {
    const { start, end } = this.day(now);
    const keys = this.keys.enabledKeys();
    const out: ModelRemaining[] = models.map((limit) => ({
      limit,
      usedToday: 0,
      remainingToday: 0,
      remainingThisMinute: 0,
      keys: { enabled: keys.length, available: 0, coolingDown: 0, nextAvailableAt: null },
      unavailableReason:
        limit.unavailableReason ?? (limit.rpm === 0 || limit.tpm === 0 || limit.rpd === 0 ? 'limit = 0' : null),
    }));
    const [used, rows] = await this.scripts.ggRemaining(
      this.P,
      now,
      start,
      clientId ?? '',
      models.length,
      ...models.map((m) => m.modelId),
      ...keys.map((k) => k.id),
    );
    // null (không giới hạn) lấn át mọi số khi cộng
    const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
    for (const [, mi, rpd, rpm, cd] of rows) {
      const m = out[mi];
      const l = m.limit;
      const usedDay = Number(rpd);
      m.usedToday += usedDay;
      if (m.unavailableReason) continue;
      const dayLeft = l.rpd === null ? null : Math.max(0, l.rpd - usedDay);
      const until = cd ? Number(cd.slice(0, cd.indexOf('|'))) : 0;
      if (until > now) {
        m.keys.coolingDown++;
        if (until < end) {
          m.remainingToday = add(m.remainingToday, dayLeft);
          m.keys.nextAvailableAt = Math.min(m.keys.nextAvailableAt ?? until, until);
        }
        continue;
      }
      m.remainingToday = add(m.remainingToday, dayLeft);
      const minuteLeft = l.rpm === null ? dayLeft : Math.max(0, l.rpm - Number(rpm));
      const nowLeft = minuteLeft === null || dayLeft === null ? (minuteLeft ?? dayLeft) : Math.min(minuteLeft, dayLeft);
      m.remainingThisMinute = add(m.remainingThisMinute, nowLeft);
      if (nowLeft === null || nowLeft > 0) m.keys.available++;
    }
    return { now, dayStart: start, resetAt: end, clientUsed: used === '' ? null : Number(used), models: out };
  }

  /** Số request tính quota hôm nay của 1 client key (đọc log; dùng cho key không có hạn mức riêng nên không có bộ đếm Redis). */
  clientRequestsToday(clientId: number, now = Date.now()) {
    this.flush();
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM request_log WHERE ts >= ? AND client_id = ? AND status IN ${COUNTED}`)
      .get(this.day(now).start, clientId) as { n: number };
    return r.n;
  }

  /** Chốt kết quả 1 request: sửa dòng log, và trả lại chỗ trong Redis nếu request không tính quota. Không ném lỗi. */
  async finalize(
    logId: number,
    p: { status: LogStatus; tokens?: number | null; httpStatus?: number; error?: string | null; latencyMs?: number },
  ) {
    const f = this.inflight.get(logId);
    if (!f) return; // bộ đếm đã bị dựng lại (import backup) trong lúc request đang chạy
    this.inflight.delete(logId);
    const { row } = f;

    // Dòng log còn trong hàng đợi insert thì sửa tại chỗ (chỉ 1 lệnh ghi); đã xuống DB thì xếp thêm 1 update.
    row.status = p.status;
    if (p.tokens != null) row.tokens = p.tokens;
    row.httpStatus = p.httpStatus ?? null;
    row.error = p.error ? p.error.slice(0, 500) : null;
    row.latencyMs = p.latencyMs ?? null;
    if (!row.queued) this.updateQueue.push(row);

    const counted = p.status === 'ok' || p.status === 'error';
    const ok = p.status === 'ok';
    if (counted && !ok && p.tokens == null) return; // giữ nguyên chỗ và số token ước lượng
    try {
      await this.scripts.ggFinalize(this.P, f.pair, f.day, logId, counted ? 1 : 0, p.tokens ?? '', row.clientId ?? '', ok ? 1 : 0);
    } catch (e: any) {
      this.log.error(`finalize #${logId}: ${e?.message || e}`);
    }
  }

  // ---------------------------------------------------------------- dashboard

  /** Số liệu cho dashboard, đọc từ Redis: usage[keyId][modelId] */
  async snapshot() {
    const now = Date.now();
    const { start, end } = this.day(now);
    const usage: Record<number, Record<string, { rpm: number; tpm: number; rpd: number }>> = {};
    for (const [pair, rpd, rpm, tpm] of await this.scripts.ggSnapshot(this.P, now, start)) {
      const sep = pair.indexOf('|');
      const u = { rpm: Number(rpm), tpm: Number(tpm), rpd: Number(rpd) };
      if (u.rpd || u.rpm) (usage[Number(pair.slice(0, sep))] ||= {})[pair.slice(sep + 1)] = u;
    }
    return { now, dayStart: start, dayEnd: end, usage, cooldowns: await this.listCooldowns(now) };
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
