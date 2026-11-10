import { All, Controller, Get, Logger, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { quotaDayEnd } from "../common/time";
import { ClientContext, ClientsService } from "../clients/clients.service";
import { KeysService } from "../keys/keys.service";
import { capabilityMismatch, Operation } from "../limits/capability";
import { unsupportedReason } from "../limits/limits-parser";
import { LimitsService, ModelLimit } from "../limits/limits.service";
import { QuotaService } from "./quota.service";
import { classifyUpstreamError, googleError } from "./upstream-error";

/** Các method tốn quota generate. countTokens / list models đi thẳng, không tính. */
const COUNTED_METHODS = new Set([
  "generateContent",
  "streamGenerateContent",
  "embedContent",
  "batchEmbedContents",
]);
/** Model gateway tự chọn mà Google trả 404: bỏ qua trong bao lâu trước khi thử lại. */
const MODEL_NOT_FOUND_COOLDOWN_MS = 3600_000;
/** Google trả 429 liên tiếp cho một cặp key+model: thời gian khoá tăng gấp đôi mỗi lần, tối đa chừng này. */
const RATE_LIMIT_BACKOFF_CAP_MS = 3600_000;
const PATH_RE = /^\/(v1beta|v1|v1alpha)\/models\/([^/:]+):([A-Za-z]+)$/;

function estimateTokens(body: unknown): number {
  let chars = 0;
  let media = 0;
  const walk = (v: unknown, key?: string) => {
    if (typeof v === "string") {
      if (key === "data" && v.length > 2000) media++;
      else chars += v.length;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body);
  return Math.ceil(chars / 4) + media * 258;
}

/** Header báo hạn mức còn lại của client key (chỉ khi key có hạn mức request/ngày). */
function clientQuotaHeaders(
  dailyLimit: number | null,
  used: number | null,
): Record<string, string> {
  if (dailyLimit == null || used == null) return {};
  const remaining = String(Math.max(0, dailyLimit - used));
  const reset = `${Math.max(1, Math.ceil((quotaDayEnd() - Date.now()) / 1000))}s`;
  return {
    "x-gg-client-limit-requests": String(dailyLimit),
    "x-gg-client-remaining-requests": remaining,
    "x-gg-client-reset-requests": reset,
    // cùng tên với header của OpenAI để SDK / client có sẵn đọc được; số là của client key, không phải của model
    "x-ratelimit-limit-requests": String(dailyLimit),
    "x-ratelimit-remaining-requests": remaining,
    "x-ratelimit-reset-requests": reset,
  };
}

function lastTotalTokens(text: string): number | null {
  const all = [
    ...text.matchAll(/"(?:totalTokenCount|total_tokens)"\s*:\s*(\d+)/g),
  ];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

type Fmt = "gemini" | "openai";

interface Target {
  model: string;
  fmt: Fmt;
  op: Operation;
  stream: boolean;
  /** URL và body gửi lên Google cho 1 model cụ thể (gateway có thể tự chọn model khác với tên client gửi) */
  url: (model: string) => string;
  body: (model: string) => unknown;
  headers: (apiKey: string) => Record<string, string>;
}

/** Lỗi do router tự sinh: theo format Google hoặc format OpenAI tuỳ endpoint client gọi. */
function errBody(
  fmt: Fmt,
  code: number,
  status: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  if (fmt === "gemini") return googleError(code, status, message, extra);
  const type =
    code === 429
      ? "rate_limit_error"
      : code === 401
        ? "authentication_error"
        : code >= 500
          ? "server_error"
          : "invalid_request_error";
  return {
    error: { message, type, param: null, code: status.toLowerCase(), ...extra },
  };
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
  private readonly log = new Logger("GeminiProxy");
  private readonly base =
    process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
  private readonly maxAttempts = Math.max(
    1,
    Number(process.env.MAX_ATTEMPTS) || 4,
  );
  /**
   * Thời gian tối đa cho việc THỬ LẠI của 1 request. Lần gọi đầu tiên không bị giới hạn (để model trả lời dài vẫn
   * xong), nhưng quá mốc này thì không thử key/model khác nữa và lần thử lại đang chờ bị huỷ, trả lỗi kèm
   * Retry-After. Đặt thấp hơn timeout phía client để client nhận lỗi rõ ràng thay vì tự timeout.
   */
  private readonly deadlineMs = Math.max(
    100,
    Number(process.env.ROUTER_DEADLINE_MS) || 45_000,
  );
  /** Trong 1 request: số lần 1 model bị Google từ chối vì quá tải trước khi bỏ sang model kế. */
  private readonly overloadTriesPerModel = 2;

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
  private auth(
    req: Request,
    res: Response,
    fmt: Fmt = "gemini",
  ): ClientContext | null {
    const master = process.env.PROXY_TOKEN;
    const got =
      (req.header("authorization") || "").replace(/^Bearer\s+/i, "") ||
      req.header("x-goog-api-key") ||
      (typeof req.query.key === "string" ? req.query.key : "");
    if (got) {
      if (master && got === master)
        return { id: null, name: "master", allowedModels: null, dailyLimit: null };
      const c = this.clients.authenticate(got);
      if (c) return c;
    }
    if (!master && this.clients.count() === 0)
      return { id: null, name: "open", allowedModels: null, dailyLimit: null };
    res
      .status(401)
      .json(
        errBody(
          fmt,
          401,
          "UNAUTHENTICATED",
          "API key không hợp lệ hoặc đã bị tắt",
        ),
      );
    return null;
  }

  private forwardQuery(req: Request) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query))
      if (k !== "key" && typeof v === "string") q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : "";
  }

  @Get("healthz")
  health() {
    return { ok: true };
  }

  // ---------- OpenAI-compatible ----------
  @Post([
    "v1/chat/completions",
    "v1/embeddings",
    "openai/v1/chat/completions",
    "openai/v1/embeddings",
  ])
  async openai(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res, "openai");
    if (!client) return;
    const model =
      typeof req.body?.model === "string"
        ? req.body.model.replace(/^models\//, "")
        : "";
    if (!model)
      return res
        .status(400)
        .json(
          errBody("openai", 400, "INVALID_ARGUMENT", 'Thiếu trường "model"'),
        );
    const endpoint = req.path.endsWith("/embeddings")
      ? "embeddings"
      : "chat/completions";
    return this.routed(req, res, client, {
      model,
      fmt: "openai",
      op: endpoint === "embeddings" ? "openai-embeddings" : "openai-chat",
      stream: req.body?.stream === true,
      url: () => `${this.base}/v1beta/openai/${endpoint}`,
      body: (m) => ({ ...(req.body ?? {}), model: m }),
      headers: (k) => ({ authorization: `Bearer ${k}` }),
    });
  }

  @Get(["v1/models", "openai/v1/models"])
  async openaiModels(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res, "openai");
    if (!client) return;
    if (client.allowedModels) {
      // key bị giới hạn model -> chỉ liệt kê những model nó được phép gọi
      const allowed = new Set(client.allowedModels);
      const data = this.limits
        .list()
        .filter((l) => allowed.has(l.modelId))
        .map((l) => ({
          id: l.modelId,
          object: "model",
          created: 0,
          owned_by: "google",
        }));
      return res.json({ object: "list", data });
    }
    return this.passthrough(
      req,
      res,
      `${this.base}/v1beta/openai/models`,
      (k) => ({ authorization: `Bearer ${k}` }),
    );
  }

  /**
   * Quota còn lại cho chính client key đang gọi: hạn mức riêng của key + quota của từng model key được phép dùng
   * trên toàn pool. Chỉ đọc, không tốn quota. ?model=<id> để hỏi 1 model.
   */
  @Get(["v1/quota", "openai/v1/quota"])
  async clientQuota(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res, "openai");
    if (!client) return;
    const allowed = client.allowedModels ? new Set(client.allowedModels) : null;
    let models = this.limits
      .list()
      .filter((l) => !allowed || allowed.has(l.modelId));
    const want =
      typeof req.query.model === "string"
        ? req.query.model.replace(/^models\//, "")
        : "";
    if (want) {
      const l = this.limits.resolve(want);
      if (!l)
        return res
          .status(404)
          .json(
            errBody("openai", 404, "NOT_FOUND", `Model "${want}" chưa có trong bảng limits`),
          );
      if (allowed && !allowed.has(l.modelId))
        return res
          .status(403)
          .json(
            errBody(
              "openai",
              403,
              "PERMISSION_DENIED",
              `Key "${client.name}" không được phép dùng model "${want}". Xem GET /v1/models.`,
            ),
          );
      models = [l];
    }

    const limited = client.id != null && client.dailyLimit != null;
    let q: Awaited<ReturnType<QuotaService["remaining"]>>;
    try {
      q = await this.quota.remaining(models, limited ? client.id : null);
    } catch (e: any) {
      this.log.error(`Redis lỗi khi đọc quota: ${e?.message || e}`);
      res.setHeader("Retry-After", "5");
      return res
        .status(503)
        .json(
          errBody(
            "openai",
            503,
            "UNAVAILABLE",
            "Gateway tạm thời không đọc được bộ đếm quota (Redis). Thử lại sau vài giây.",
          ),
        );
    }

    const usedToday =
      client.id == null
        ? null
        : (q.clientUsed ?? this.quota.clientRequestsToday(client.id));
    const clientRemaining =
      client.dailyLimit == null
        ? null
        : Math.max(0, client.dailyLimit - (usedToday ?? 0));
    // gọi bằng tên không có trong bảng (vd "auto"): gateway thử lần lượt các model chat được phép
    let pool: number | null = 0;
    for (const m of q.models)
      if (
        !m.unavailableReason &&
        !capabilityMismatch(m.limit.capability, "openai-chat", m.limit.modelId)
      )
        pool =
          pool === null || m.remainingToday === null
            ? null
            : pool + m.remainingToday;
    const autoRemainingToday =
      clientRemaining === null
        ? pool
        : pool === null
          ? clientRemaining
          : Math.min(clientRemaining, pool);
    const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

    res.set(clientQuotaHeaders(client.dailyLimit, usedToday));
    return res.json({
      object: "quota",
      // số gateway tự đếm: request gọi thẳng Google bằng cùng key thì không thấy
      estimated: true,
      resetAt: iso(q.resetAt),
      resetInSeconds: Math.max(0, Math.ceil((q.resetAt - q.now) / 1000)),
      client: {
        name: client.name,
        dailyLimit: client.dailyLimit,
        usedToday,
        remainingToday: clientRemaining,
      },
      autoRemainingToday,
      models: q.models.map((m) => ({
        model: m.limit.modelId,
        displayName: m.limit.displayName,
        capability: m.limit.capability,
        limit: { rpm: m.limit.rpm, tpm: m.limit.tpm, rpd: m.limit.rpd },
        usedToday: m.usedToday,
        remainingToday: m.unavailableReason ? 0 : m.remainingToday,
        remainingThisMinute: m.unavailableReason ? 0 : m.remainingThisMinute,
        unavailableReason: m.unavailableReason,
        keys: { ...m.keys, nextAvailableAt: iso(m.keys.nextAvailableAt) },
      })),
    });
  }

  // ---------- Gemini native ----------
  /** Các method generate/embed đi qua router; còn lại (list models, countTokens) passthrough, không tính quota. */
  @All([
    "v1beta/models",
    "v1beta/models/*rest",
    "v1/models/*rest",
    "v1alpha/models/*rest",
  ])
  async handle(@Req() req: Request, @Res() res: Response) {
    const client = this.auth(req, res);
    if (!client) return;
    const m = req.path.match(PATH_RE);
    if (req.method === "POST" && m && COUNTED_METHODS.has(m[3]))
      return this.routed(req, res, client, {
        model: m[2],
        fmt: "gemini",
        op:
          m[3] === "embedContent" || m[3] === "batchEmbedContents"
            ? "embed"
            : "generate",
        stream: m[3] === "streamGenerateContent",
        url: (model) =>
          `${this.base}/${m[1]}/models/${model}:${m[3]}${this.forwardQuery(req)}`,
        body: () => req.body ?? {},
        headers: (k) => ({ "x-goog-api-key": k }),
      });
    return this.passthrough(req, res);
  }

  private async passthrough(
    req: Request,
    res: Response,
    url = `${this.base}${req.path}${this.forwardQuery(req)}`,
    headers: Target["headers"] = (k) => ({ "x-goog-api-key": k }),
  ) {
    const key = this.keys.enabledKeys()[0];
    if (!key)
      return res
        .status(503)
        .json(googleError(503, "UNAVAILABLE", "Chưa có key nào đang bật"));
    try {
      const up = await fetch(url, {
        method: req.method,
        headers: {
          "content-type": "application/json",
          ...headers(key.api_key),
        },
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : JSON.stringify(req.body ?? {}),
        signal: AbortSignal.timeout(60_000),
      });
      res
        .status(up.status)
        .type(up.headers.get("content-type") || "application/json")
        .send(await up.text());
    } catch (e: any) {
      res
        .status(502)
        .json(
          googleError(502, "UNAVAILABLE", `Upstream error: ${e?.message || e}`),
        );
    }
  }

  /**
   * Model nào sẽ được thử cho request này, theo thứ tự:
   *  - tên client gửi có trong bảng limits -> đúng model đó (phải nằm trong danh sách được phép của key)
   *  - tên KHÔNG có trong bảng (vd "auto", tên key, bất kỳ) và key có danh sách model
   *    -> gateway tự quyết: thử lần lượt các model của key, model nào hết quota thì sang model kế
   */
  private pickModels(
    client: ClientContext,
    t: Target,
  ):
    | { models: { limit: ModelLimit; sendAs: string }[] }
    | { error: [number, string, string] } {
    const requested = t.model;
    const direct = this.limits.resolve(requested);
    if (direct) {
      if (
        client.allowedModels &&
        !client.allowedModels.includes(direct.modelId)
      )
        return {
          error: [
            403,
            "PERMISSION_DENIED",
            `Key "${client.name}" không được phép dùng model "${requested}". Xem GET /v1/models.`,
          ],
        };
      // Live API (WebSocket) / Agents (Interactions API): proxy HTTP này không gọi được
      const unsupported = unsupportedReason(direct.category);
      if (unsupported)
        return {
          error: [
            400,
            "INVALID_ARGUMENT",
            `Model "${direct.displayName}" thuộc ${unsupported}.`,
          ],
        };
      // chặn trước khi tốn quota: vd gọi model TTS qua chat/completions
      const mismatch = capabilityMismatch(direct.capability, t.op, requested);
      if (mismatch) return { error: [400, "INVALID_ARGUMENT", mismatch] };
      if (direct.rpm === 0 || direct.tpm === 0 || direct.rpd === 0)
        return {
          error: [
            429,
            "RESOURCE_EXHAUSTED",
            `Model "${direct.displayName}" không có quota free tier (limit = 0).`,
          ],
        };
      return { models: [{ limit: direct, sendAs: requested }] };
    }

    if (!client.allowedModels)
      return {
        error: [
          400,
          "INVALID_ARGUMENT",
          `Model "${requested}" chưa có trong bảng limits. Thêm model hoặc alias ở tab Limits, hoặc dùng client key có chọn sẵn model để gateway tự quyết.`,
        ],
      };

    const byId = new Map(this.limits.list().map((l) => [l.modelId, l]));
    const models = client.allowedModels
      .map((id) => byId.get(id))
      .filter(
        (l): l is ModelLimit =>
          !!l &&
          !l.unavailableReason &&
          !capabilityMismatch(l.capability, t.op, l.modelId),
      )
      .map((limit) => ({ limit, sendAs: limit.modelId }));
    if (!models.length)
      return {
        error: [
          400,
          "INVALID_ARGUMENT",
          `Key "${client.name}" không có model nào dùng được cho endpoint này.`,
        ],
      };
    return { models };
  }

  private async routed(
    req: Request,
    res: Response,
    client: ClientContext,
    t: Target,
  ) {
    const picked = this.pickModels(client, t);
    if ("error" in picked)
      return res.status(picked.error[0]).json(errBody(t.fmt, ...picked.error));
    const autoPicked = !this.limits.resolve(t.model);

    const est = estimateTokens(req.body);
    const attempts: { keyId: number; status: number; kind: string }[] = [];
    let lastFailure: {
      status: number;
      body: string;
      contentType: string;
    } | null = null;
    /** model đã hết quota local trên mọi key (không gọi Google lần nào) */
    const exhausted: {
      limit: ModelLimit;
      reason: string;
      retryAt: number | null;
      detail: string[];
    }[] = [];

    const deadline = Date.now() + this.deadlineMs;
    /** sớm nhất khi nào một model bị tạm nghỉ vì quá tải hết nghỉ (gợi ý Retry-After) */
    let pausedUntil: number | null = null;
    const notePause = (until: number) => {
      if (until > Date.now()) pausedUntil = Math.min(pausedUntil ?? until, until);
    };
    let deadlineHit = false;

    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ctrl.abort();
    });

    // Mỗi model được thử tối đa maxAttempts key; hết key/quota thì sang model kế (khi gateway tự chọn model).
    models: for (const { limit, sendAs: model } of picked.models) {
      const exclude = new Set<number>();
      let tries = 0;
      let overloads = 0;
      let skipModel = false;
      while (tries < this.maxAttempts) {
        // đã gọi Google ít nhất 1 lần mà quá hạn -> thôi, không thử thêm
        if (attempts.length > 0 && Date.now() >= deadline) {
          deadlineHit = true;
          break models;
        }
        let r: Awaited<ReturnType<QuotaService["reserve"]>>;
        try {
          r = await this.quota.reserve(
            limit,
            t.model,
            est,
            exclude,
            client.id,
            client.dailyLimit,
            autoPicked,
          );
        } catch (e: any) {
          // Redis giữ bộ đếm quota: không đọc được thì không chọn key an toàn được -> báo 503, không gọi mù lên Google
          this.log.error(`Redis lỗi khi giữ chỗ quota: ${e?.message || e}`);
          res.setHeader("Retry-After", "5");
          return res
            .status(503)
            .json(
              errBody(
                t.fmt,
                503,
                "UNAVAILABLE",
                "Gateway tạm thời không đọc được bộ đếm quota (Redis). Thử lại sau vài giây.",
              ),
            );
        }
        if (!r.ok) {
          // hạn mức riêng của client key: đổi key Google hay đổi model cũng không gọi tiếp được
          if (r.reason === "client_limit") {
            const retryAfter = Math.max(
              1,
              Math.ceil(((r.retryAt ?? Date.now()) - Date.now()) / 1000),
            );
            res.setHeader("Retry-After", String(retryAfter));
            res.setHeader("x-gg-attempts", String(attempts.length));
            res.set(clientQuotaHeaders(client.dailyLimit, client.dailyLimit));
            return res.status(429).json(
              errBody(
                t.fmt,
                429,
                "RESOURCE_EXHAUSTED",
                `Key "${client.name}" đã hết hạn mức ${client.dailyLimit} request/ngày — reset lúc 00:00 giờ Pacific (sau ~${retryAfter}s)`,
                {
                  router: {
                    retryAfterSeconds: retryAfter,
                    clientLimit: client.dailyLimit,
                  },
                },
              ),
            );
          }
          // key chỉ đang bận (đủ request đồng thời), không hết quota: chờ chút rồi giữ chỗ lại thay vì báo lỗi
          if (r.reason === "exhausted" && r.busyOnly && Date.now() + 250 < deadline) {
            await new Promise((ok) => setTimeout(ok, 250));
            if (ctrl.signal.aborted) return;
            continue;
          }
          if (r.reason === "paused" && r.retryAt) notePause(r.retryAt);
          if (tries === 0)
            exhausted.push({
              limit,
              reason: r.reason,
              retryAt: r.retryAt,
              detail: r.detail,
            });
          break; // sang model kế
        }
        tries++;

        const { key, logId } = r;
        const quotaHeaders = clientQuotaHeaders(client.dailyLimit, r.clientUsed);
        exclude.add(key.id);
        const started = Date.now();

        // lần thử lại: chỉ được chờ tới mốc deadline (tính tới lúc Google bắt đầu trả lời)
        const retryCtl = attempts.length > 0 ? new AbortController() : null;
        const retryTimer = retryCtl
          ? setTimeout(() => retryCtl.abort(), Math.max(0, deadline - Date.now()))
          : null;
        let up: globalThis.Response;
        try {
          up = await fetch(t.url(model), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...t.headers(key.api_key),
            },
            body: JSON.stringify(t.body(model)),
            signal: AbortSignal.any([
              ctrl.signal,
              AbortSignal.timeout(10 * 60_000),
              ...(retryCtl ? [retryCtl.signal] : []),
            ]),
          });
        } catch (e: any) {
          const timedOut = !ctrl.signal.aborted && !!retryCtl?.signal.aborted;
          const msg = timedOut
            ? `quá ${Math.round(this.deadlineMs / 1000)}s (ROUTER_DEADLINE_MS) mà Google chưa trả lời lần thử lại`
            : e?.message || String(e);
          await this.quota.finalize(logId, {
            status: "network_error",
            error: msg,
            latencyMs: Date.now() - started,
          });
          if (ctrl.signal.aborted) return; // client đã huỷ
          if (timedOut) {
            attempts.push({ keyId: key.id, status: 0, kind: "deadline" });
            deadlineHit = true;
            break models;
          }
          attempts.push({ keyId: key.id, status: 0, kind: "network" });
          lastFailure = {
            status: 502,
            body: JSON.stringify(errBody(t.fmt, 502, "UNAVAILABLE", msg)),
            contentType: "application/json",
          };
          continue;
        } finally {
          if (retryTimer) clearTimeout(retryTimer);
        }

        const routeHeaders = {
          "x-gg-key-id": String(key.id),
          "x-gg-account": encodeURIComponent(key.account),
          "x-gg-project": encodeURIComponent(key.project),
          "x-gg-attempts": String(attempts.length + 1),
          "x-gg-model": limit.modelId,
          ...quotaHeaders,
        };

        if (up.ok) {
          if (r.probe) await this.quota.probeSucceeded(key.id, limit.modelId);
          if (t.stream && up.body)
            return this.pipeStream(up, res, logId, est, started, routeHeaders);
          const text = await up.text();
          await this.quota.finalize(logId, {
            status: "ok",
            tokens: lastTotalTokens(text) ?? est,
            httpStatus: up.status,
            latencyMs: Date.now() - started,
          });
          res.set(routeHeaders);
          return res
            .status(up.status)
            .type(up.headers.get("content-type") || "application/json")
            .send(text);
        }

        // ---- lỗi từ Google ----
        const text = await up.text();
        const ce = classifyUpstreamError(up.status, text);
        const latencyMs = Date.now() - started;
        const label = `#${key.id} ${key.account}/${key.project}`;
        attempts.push({ keyId: key.id, status: up.status, kind: ce.kind });
        lastFailure = {
          status: up.status,
          body: text,
          contentType: up.headers.get("content-type") || "application/json",
        };

        switch (ce.kind) {
          case "rate_limit": {
            // Local nói còn quota nhưng Google nói hết -> tin Google: cooldown theo loại quota bị vượt.
            const perDay = ce.quotaIds.some((q) => /PerDay/i.test(q));
            let why = `429 ${ce.quotaIds[0] || "RESOURCE_EXHAUSTED"}`;
            let until: number;
            // 429 không nói quota nào: có thể là Google quá tải model chứ không phải key hết quota
            const ovl = ce.quotaIds.length
              ? null
              : await this.quota.overload(key.id, limit.modelId);
            if (perDay) {
              until = quotaDayEnd();
              await this.quota.setCooldown(key.id, limit.modelId, until, why);
            } else if (ovl?.paused) {
              // nhiều key cùng bị trong vài giây: lỗi của model, không khoá key (để hết nghỉ là dùng lại được ngay)
              until = ovl.until;
              why += " (Google quá tải model)";
              notePause(ovl.until);
              skipModel = true;
              if (ovl.justPaused)
                this.log.warn(
                  `${limit.modelId}: nhiều key cùng bị 429 -> Google đang quá tải, tạm nghỉ model tới ${new Date(ovl.until).toISOString()}`,
                );
            } else {
              // Không biết là quota phút hay ngày (Google thường không nói): khoá lâu dần. Quota phút thì phút sau
              // gọi lại được và chuỗi tự xoá; quota ngày đã cạn thì mỗi lần thử lại thất bại khoá gấp đôi, tối đa
              // 1 giờ và không quá giờ reset, thay vì cứ 60s lại bắn một loạt request vô ích lên Google.
              const base = Math.max(ce.retryDelayMs ?? 60_000, 5_000);
              const cap = Math.max(base, Math.min(RATE_LIMIT_BACKOFF_CAP_MS, quotaDayEnd() - Date.now()));
              const b = await this.quota.backoff(key.id, limit.modelId, base, cap, why);
              until = b.until;
              if (b.strikes > 1) why += ` (lần ${b.strikes} liên tiếp)`;
            }
            await this.quota.finalize(logId, {
              status: "rate_limited",
              httpStatus: 429,
              error: `${why}: ${ce.message}`,
              latencyMs,
            });
            if (!ovl?.paused)
              this.log.warn(
                `${label} ${limit.modelId}: ${why} -> cooldown tới ${new Date(until).toISOString()}`,
              );
            if (ovl && ++overloads >= this.overloadTriesPerModel) skipModel = true;
            break;
          }
          case "auth": {
            this.keys.disable(
              key.id,
              `${ce.reason || up.status}: ${ce.message}`.slice(0, 300),
            );
            await this.quota.finalize(logId, {
              status: "auth_error",
              httpStatus: up.status,
              error: ce.message,
              latencyMs,
            });
            this.log.error(`${label}: key bị tắt (${ce.reason || up.status})`);
            continue;
          }
          case "forbidden": {
            // 403 khác (vd model không mở cho project/region này) -> chỉ khoá cặp key+model 1 giờ
            await this.quota.setCooldown(
              key.id,
              limit.modelId,
              Date.now() + 3600_000,
              `403 ${ce.reason || ""}`.trim(),
            );
            await this.quota.finalize(logId, {
              status: "auth_error",
              httpStatus: 403,
              error: ce.message,
              latencyMs,
            });
            continue;
          }
          case "transient": {
            // 5xx/overloaded thường là phía model, không phạt key; thử key khác, nhưng nhiều key cùng bị thì nghỉ model
            await this.quota.finalize(logId, {
              status: "upstream_error",
              httpStatus: up.status,
              error: ce.message,
              latencyMs,
            });
            if (up.status === 503 || up.status === 429) {
              const ovl = await this.quota.overload(key.id, limit.modelId);
              if (ovl.paused) {
                notePause(ovl.until);
                skipModel = true;
                if (ovl.justPaused)
                  this.log.warn(
                    `${limit.modelId}: nhiều key cùng bị ${up.status} -> Google đang quá tải, tạm nghỉ model tới ${new Date(ovl.until).toISOString()}`,
                  );
              }
              if (++overloads >= this.overloadTriesPerModel) skipModel = true;
            }
            break;
          }
          default: {
            await this.quota.finalize(logId, {
              status: "client_error",
              httpStatus: up.status,
              error: ce.message,
              latencyMs,
            });
            // Gateway tự chọn model mà Google không biết model này (id trong bảng limits chưa đúng) -> thử model kế
            if (autoPicked && up.status === 404) {
              // 404 là lỗi của model chứ không phải của key: khoá ở mức model 1 giờ (không đặt cooldown lên
              // từng key) để các request sau bỏ qua luôn, không tốn 1 lượt gọi mỗi request. Sửa model id ở
              // tab Limits hoặc bỏ khoá ở tab Quota thì thử lại ngay.
              const until = Date.now() + MODEL_NOT_FOUND_COOLDOWN_MS;
              await this.quota.blockModel(
                limit.modelId,
                until,
                `Google trả 404: ${ce.message}`.slice(0, 200),
              );
              this.log.warn(
                `${limit.modelId}: Google trả 404 -> bỏ qua model này tới ${new Date(until).toISOString()}, kiểm tra lại model id ở tab Limits`,
              );
              skipModel = true;
              break;
            }
            // 400/404...: lỗi request của client -> không failover, trả nguyên lỗi.
            // Request này không tính quota (đã trả lại chỗ) nên không gửi số còn lại vừa đọc lúc giữ chỗ.
            for (const h of Object.keys(quotaHeaders)) delete (routeHeaders as Record<string, string>)[h];
            res.set(routeHeaders);
            return res
              .status(up.status)
              .type(lastFailure.contentType)
              .send(text);
          }
        }
        if (skipModel) break;
      }
    }

    res.setHeader("x-gg-attempts", String(attempts.length));
    if (deadlineHit) res.setHeader("x-gg-deadline", String(this.deadlineMs));
    const pauseAfter =
      pausedUntil != null
        ? Math.max(1, Math.ceil((pausedUntil - Date.now()) / 1000))
        : null;
    if (lastFailure) {
      const retryable = lastFailure.status === 429 || lastFailure.status >= 500;
      if (retryable && (pauseAfter || deadlineHit))
        res.setHeader("Retry-After", String(pauseAfter ?? 5));
      return res
        .status(lastFailure.status)
        .type(lastFailure.contentType)
        .send(lastFailure.body);
    }
    if (exhausted.length) {
      const times = exhausted
        .map((e) => e.retryAt)
        .filter((x): x is number => x != null);
      const retryAfter = times.length
        ? Math.max(1, Math.ceil((Math.min(...times) - Date.now()) / 1000))
        : null;
      if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
      const names = exhausted.map((e) => e.limit.displayName).join(", ");
      const allPaused = exhausted.every((e) => e.reason === "paused");
      const allBlocked = exhausted.every((e) => e.reason === "model_blocked");
      return res.status(allPaused ? 503 : 429).json(
        errBody(
          t.fmt,
          allPaused ? 503 : 429,
          allPaused ? "UNAVAILABLE" : "RESOURCE_EXHAUSTED",
          exhausted.every((e) => e.reason === "no_keys")
            ? "Chưa có API key nào đang bật"
            : allPaused
              ? `Google đang quá tải ${names} (nhiều key cùng bị từ chối), gateway tạm nghỉ` +
                (retryAfter ? ` — thử lại sau ~${retryAfter}s` : "")
              : allBlocked
                ? `Google trả 404 cho ${names}, gateway tạm bỏ qua. Kiểm tra model id ở tab Limits` +
                  (retryAfter ? ` — thử lại sau ~${retryAfter}s` : "")
              : `Tất cả key đã hết quota local cho ${names}` +
                (retryAfter ? ` — thử lại sau ~${retryAfter}s` : ""),
          {
            router: {
              retryAfterSeconds: retryAfter,
              autoPicked,
              models: exhausted.map((e) => ({
                model: e.limit.modelId,
                keys: e.detail,
              })),
            },
          },
        ),
      );
    }
    return res
      .status(429)
      .json(
        errBody(t.fmt, 429, "RESOURCE_EXHAUSTED", "Đã thử hết số lần cho phép"),
      );
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
    res.setHeader(
      "content-type",
      up.headers.get("content-type") || "text/event-stream",
    );
    res.flushHeaders();
    let tail = "";
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
      await this.quota.finalize(logId, {
        status: "ok",
        tokens: tokens ?? est,
        httpStatus: up.status,
        latencyMs: Date.now() - started,
      });
      res.end();
    }
  }
}
