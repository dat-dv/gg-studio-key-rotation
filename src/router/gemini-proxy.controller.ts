import { All, Controller, Get, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { quotaDayEnd } from '../common/time';
import { ClientContext, ClientsService } from '../clients/clients.service';
import { KeysService } from '../keys/keys.service';
import { LimitsService } from '../limits/limits.service';
import { QuotaService } from './quota.service';
import { classifyUpstreamError, googleError } from './upstream-error';

/** Các method tốn quota generate. countTokens / list models đi thẳng, không tính. */
const COUNTED_METHODS = new Set(['generateContent', 'streamGenerateContent', 'embedContent', 'batchEmbedContents']);
const PATH_RE = /^\/(v1beta|v1|v1alpha)\/models\/([^/:]+):([A-Za-z]+)$/;

function estimateTokens(body: unknown): number {
  let chars = 0;
  let media = 0;
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key === 'data' && v.length > 2000) media++;
      else chars += v.length;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body);
  return Math.ceil(chars / 4) + media * 258;
}

function lastTotalTokens(text: string): number | null {
  const all = [...text.matchAll(/"(?:totalTokenCount|total_tokens)"\s*:\s*(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

type Fmt = 'gemini' | 'openai';

interface Target {
  model: string;
  fmt: Fmt;
  stream: boolean;
  url: string;
  headers: (apiKey: string) => Record<string, string>;
}

/** Lỗi do router tự sinh: theo format Google hoặc format OpenAI tuỳ endpoint client gọi. */
function errBody(fmt: Fmt, code: number, status: string, message: string, extra: Record<string, unknown> = {}) {
  if (fmt === 'gemini') return googleError(code, status, message, extra);
  const type = code === 429 ? 'rate_limit_error' : code === 401 ? 'authentication_error' : code >= 500 ? 'server_error' : 'invalid_request_error';
  return { error: { message, type, param: null, code: status.toLowerCase(), ...extra } };
}

/**
 * Proxy tương thích Gemini REST API:
 *   POST /v1beta/models/{model}:generateContent | :streamGenerateContent | :embedContent ...
 * và OpenAI API (đi qua lớp OpenAI-compatible chính thức của Gemini):
 *   POST /v1/chat/completions, POST /v1/embeddings, GET /v1/models
 * Client chỉ cần đổi baseUrl sang server này.
 */
@Controller()
export class GeminiProxyController {
  private readonly log = new Logger('GeminiProxy');
  private readonly base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  private readonly maxAttempts = Math.max(1, Number(process.env.MAX_ATTEMPTS) || 4);

  constructor(
    private readonly keys: KeysService,
    private readonly limits: LimitsService,
    private readonly quota: QuotaService,
    private readonly clients: ClientsService,
  ) {}

  /**
   * Xác thực người gọi. Token lấy từ Authorization: Bearer, x-goog-api-key hoặc ?key=.
   * - trùng PROXY_TOKEN (env)  -> master, mọi model
   * - trùng một client key     -> theo danh sách model của key đó
   * - chưa đặt PROXY_TOKEN và chưa tạo client key nào -> mở (tiện cho dev local)
   * Trả null (và đã gửi 401) nếu không hợp lệ.
   */
  private auth(req: Request, res: Response, fmt: Fmt = 'gemini'): ClientContext | null {
    const master = process.env.PROXY_TOKEN;
    const got =
      (req.header('authorization') || '').replace(/^Bearer\s+/i, '') ||
      req.header('x-goog-api-key') ||
      (typeof req.query.key === 'string' ? req.query.key : '');
    if (got) {
      if (master && got === master) return { id: null, name: 'master', allowedModels: null };
      const c = this.clients.authenticate(got);
      if (c) return c;
    }
    if (!master && this.clients.count() === 0) return { id: null, name: 'open', allowedModels: null };
    res.status(401).json(errBody(fmt, 401, 'UNAUTHENTICATED', 'API key không hợp lệ hoặc đã bị tắt'));
    return null;
  }

  private forwardQuery(req: Request) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k !== 'key' && typeof v === 'string') q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  @Get('healthz')
  health() {
    return { ok: true };
  }

  // ---------- OpenAI-compatible ----------
  @Post(['v1/chat/completions', 'v1/embeddings', 'openai/v1/chat/completions', 'openai/v1/embeddings'])
  async openai(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res, 'openai');
    if (!client) return;
    const model = typeof req.body?.model === 'string' ? req.body.model.replace(/^models\//, '') : '';
    if (!model) return res.status(400).json(errBody('openai', 400, 'INVALID_ARGUMENT', 'Thiếu trường "model"'));
    const endpoint = req.path.endsWith('/embeddings') ? 'embeddings' : 'chat/completions';
    return this.routed(req, res, client, {
      model,
      fmt: 'openai',
      stream: req.body?.stream === true,
      url: `${this.base}/v1beta/openai/${endpoint}`,
      headers: (k) => ({ authorization: `Bearer ${k}` }),
    });
  }

  @Get(['v1/models', 'openai/v1/models'])
  async openaiModels(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res, 'openai');
    if (!client) return;
    if (client.allowedModels) {
      // key bị giới hạn model -> chỉ liệt kê những model nó được phép gọi
      const allowed = new Set(client.allowedModels);
      const data = this.limits
        .list()
        .filter((l) => allowed.has(l.modelId))
        .map((l) => ({ id: l.modelId, object: 'model', created: 0, owned_by: 'google' }));
      return res.json({ object: 'list', data });
    }
    return this.passthrough(req, res, `${this.base}/v1beta/openai/models`, (k) => ({ authorization: `Bearer ${k}` }));
  }

  // ---------- Gemini native ----------
  /** Các method generate/embed đi qua router; còn lại (list models, countTokens) passthrough, không tính quota. */
  @All(['v1beta/models', 'v1beta/models/*rest', 'v1/models/*rest', 'v1alpha/models/*rest'])
  async handle(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res);
    if (!client) return;
    const m = req.path.match(PATH_RE);
    if (req.method === 'POST' && m && COUNTED_METHODS.has(m[3]))
      return this.routed(req, res, client, {
        model: m[2],
        fmt: 'gemini',
        stream: m[3] === 'streamGenerateContent',
        url: `${this.base}/${m[1]}/models/${m[2]}:${m[3]}${this.forwardQuery(req)}`,
        headers: (k) => ({ 'x-goog-api-key': k }),
      });
    return this.passthrough(req, res);
  }

  private async passthrough(
    req: Request,
    res: Response,
    url = `${this.base}${req.path}${this.forwardQuery(req)}`,
    headers: Target['headers'] = (k) => ({ 'x-goog-api-key': k }),
  ) {
    const key = this.keys.enabledKeys()[0];
    if (!key) return res.status(503).json(googleError(503, 'UNAVAILABLE', 'Chưa có key nào đang bật'));
    try {
      const up = await fetch(url, {
        method: req.method,
        headers: { 'content-type': 'application/json', ...headers(key.api_key) },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
      res.status(up.status).type(up.headers.get('content-type') || 'application/json').send(await up.text());
    } catch (e: any) {
      res.status(502).json(googleError(502, 'UNAVAILABLE', `Upstream error: ${e?.message || e}`));
    }
  }

  private async routed(req: Request, res: Response, client: ClientContext, t: Target) {
    const { model } = t;
    const limit = this.limits.resolve(model);
    if (!limit)
      return res
        .status(400)
        .json(
          errBody(t.fmt, 
            400,
            'INVALID_ARGUMENT',
            `Model "${model}" chưa có trong bảng limits. Thêm model hoặc alias ở tab Limits trên UI.`,
          ),
        );
    if (client.allowedModels && !client.allowedModels.includes(limit.modelId))
      return res
        .status(403)
        .json(errBody(t.fmt, 403, 'PERMISSION_DENIED', `Key "${client.name}" không được phép dùng model "${model}". Xem GET /v1/models.`));
    if (limit.rpm === 0 || limit.tpm === 0 || limit.rpd === 0)
      return res
        .status(429)
        .json(
          errBody(t.fmt, 429, 'RESOURCE_EXHAUSTED', `Model "${limit.displayName}" không có quota free tier (limit = 0).`),
        );

    const est = estimateTokens(req.body);
    const exclude = new Set<number>();
    const attempts: { keyId: number; status: number; kind: string }[] = [];
    let lastFailure: { status: number; body: string; contentType: string } | null = null;

    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ctrl.abort();
    });

    while (attempts.length < this.maxAttempts) {
      const r = this.quota.reserve(limit, model, est, exclude, client.id);
      if (!r.ok) {
        if (lastFailure) break; // đã thử key thật mà vẫn fail -> trả lỗi upstream cuối cùng
        const retryAfter = r.retryAt ? Math.max(1, Math.ceil((r.retryAt - Date.now()) / 1000)) : null;
        if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json(
          errBody(t.fmt, 
            429,
            'RESOURCE_EXHAUSTED',
            r.reason === 'no_keys'
              ? 'Chưa có API key nào đang bật'
              : `Tất cả key đã hết quota local cho ${limit.displayName}` +
                  (retryAfter ? ` — thử lại sau ~${retryAfter}s` : ''),
            { router: { retryAfterSeconds: retryAfter, keys: r.detail } },
          ),
        );
      }

      const { key, logId } = r;
      exclude.add(key.id);
      const started = Date.now();

      let up: globalThis.Response;
      try {
        up = await fetch(t.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...t.headers(key.api_key) },
          body: JSON.stringify(req.body ?? {}),
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(10 * 60_000)]),
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        this.quota.finalize(logId, { status: 'network_error', error: msg, latencyMs: Date.now() - started });
        if (ctrl.signal.aborted) return; // client đã huỷ
        attempts.push({ keyId: key.id, status: 0, kind: 'network' });
        lastFailure = { status: 502, body: JSON.stringify(errBody(t.fmt, 502, 'UNAVAILABLE', msg)), contentType: 'application/json' };
        continue;
      }

      const routeHeaders = {
        'x-gg-key-id': String(key.id),
        'x-gg-account': encodeURIComponent(key.account),
        'x-gg-project': encodeURIComponent(key.project),
        'x-gg-attempts': String(attempts.length + 1),
      };

      if (up.ok) {
        if (t.stream && up.body) return this.pipeStream(up, res, logId, est, started, routeHeaders);
        const text = await up.text();
        this.quota.finalize(logId, {
          status: 'ok',
          tokens: lastTotalTokens(text) ?? est,
          httpStatus: up.status,
          latencyMs: Date.now() - started,
        });
        res.set(routeHeaders);
        return res.status(up.status).type(up.headers.get('content-type') || 'application/json').send(text);
      }

      // ---- lỗi từ Google ----
      const text = await up.text();
      const ce = classifyUpstreamError(up.status, text);
      const latencyMs = Date.now() - started;
      const label = `#${key.id} ${key.account}/${key.project}`;
      attempts.push({ keyId: key.id, status: up.status, kind: ce.kind });
      lastFailure = { status: up.status, body: text, contentType: up.headers.get('content-type') || 'application/json' };

      switch (ce.kind) {
        case 'rate_limit': {
          // Local nói còn quota nhưng Google nói hết -> tin Google: cooldown theo loại quota bị vượt.
          const perDay = ce.quotaIds.some((q) => /PerDay/i.test(q));
          const until = perDay ? quotaDayEnd() : Date.now() + Math.max(ce.retryDelayMs ?? 60_000, 5_000);
          const why = `429 ${ce.quotaIds[0] || 'RESOURCE_EXHAUSTED'}`;
          this.quota.setCooldown(key.id, limit.modelId, until, why);
          this.quota.finalize(logId, { status: 'rate_limited', httpStatus: 429, error: `${why}: ${ce.message}`, latencyMs });
          this.log.warn(`${label} ${limit.modelId}: ${why} -> cooldown tới ${new Date(until).toISOString()}`);
          continue;
        }
        case 'auth': {
          this.keys.disable(key.id, `${ce.reason || up.status}: ${ce.message}`.slice(0, 300));
          this.quota.finalize(logId, { status: 'auth_error', httpStatus: up.status, error: ce.message, latencyMs });
          this.log.error(`${label}: key bị tắt (${ce.reason || up.status})`);
          continue;
        }
        case 'forbidden': {
          // 403 khác (vd model không mở cho project/region này) -> chỉ khoá cặp key+model 1 giờ
          this.quota.setCooldown(key.id, limit.modelId, Date.now() + 3600_000, `403 ${ce.reason || ''}`.trim());
          this.quota.finalize(logId, { status: 'auth_error', httpStatus: 403, error: ce.message, latencyMs });
          continue;
        }
        case 'transient': {
          // 5xx/overloaded thường là phía model, không phạt key; thử key khác
          this.quota.finalize(logId, { status: 'upstream_error', httpStatus: up.status, error: ce.message, latencyMs });
          continue;
        }
        default: {
          // 400/404...: lỗi request của client -> không failover, trả nguyên lỗi
          this.quota.finalize(logId, { status: 'client_error', httpStatus: up.status, error: ce.message, latencyMs });
          res.set(routeHeaders);
          return res.status(up.status).type(lastFailure.contentType).send(text);
        }
      }
    }

    res.setHeader('x-gg-attempts', String(attempts.length));
    if (lastFailure) return res.status(lastFailure.status).type(lastFailure.contentType).send(lastFailure.body);
    return res.status(429).json(errBody(t.fmt, 429, 'RESOURCE_EXHAUSTED', 'Đã thử hết số lần cho phép'));
  }

  private async pipeStream(
    up: globalThis.Response,
    res: Response,
    logId: number,
    est: number,
    started: number,
    routeHeaders: Record<string, string>,
  ) {
    res.status(up.status);
    res.set(routeHeaders);
    res.setHeader('content-type', up.headers.get('content-type') || 'text/event-stream');
    res.flushHeaders();
    let tail = '';
    let tokens: number | null = null;
    const decoder = new TextDecoder();
    try {
      const reader = up.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        tail = (tail + decoder.decode(value, { stream: true })).slice(-16_384);
        tokens = lastTotalTokens(tail) ?? tokens;
      }
    } catch (e: any) {
      this.log.warn(`stream bị ngắt: ${e?.message || e}`);
    } finally {
      this.quota.finalize(logId, { status: 'ok', tokens: tokens ?? est, httpStatus: up.status, latencyMs: Date.now() - started });
      res.end();
    }
  }
}
