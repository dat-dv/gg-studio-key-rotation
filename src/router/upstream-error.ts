export type ErrorKind = 'rate_limit' | 'auth' | 'forbidden' | 'transient' | 'client';

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
  reason: string | null;
  quotaIds: string[];
  retryDelayMs: number | null;
}

/** Các reason nghĩa là KEY/PROJECT hỏng -> tắt key luôn. */
const KEY_DEAD_REASONS = new Set([
  'API_KEY_INVALID',
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'CONSUMER_SUSPENDED',
  'SERVICE_DISABLED',
  'BILLING_DISABLED',
]);

function parseDuration(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/^([\d.]+)s$/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

/**
 * Phân loại lỗi từ Gemini API. 429 của Google trả kèm google.rpc.QuotaFailure
 * (quotaId kiểu "GenerateRequestsPerDayPerProjectPerModel-FreeTier") và
 * google.rpc.RetryInfo (retryDelay "37s").
 */
export function classifyUpstreamError(status: number, bodyText: string): ClassifiedError {
  let body: any = null;
  try {
    body = JSON.parse(bodyText);
    if (Array.isArray(body)) body = body[0]; // streamGenerateContent không có alt=sse trả về mảng
  } catch {
    /* not json */
  }
  const err = body?.error || {};
  const details: any[] = Array.isArray(err.details) ? err.details : [];
  const message: string = err.message || bodyText.slice(0, 300) || `HTTP ${status}`;

  let reason: string | null = null;
  const quotaIds: string[] = [];
  let retryDelayMs: number | null = null;
  for (const d of details) {
    const type = String(d?.['@type'] || '');
    if (type.endsWith('ErrorInfo') && d.reason) reason = d.reason;
    if (type.endsWith('QuotaFailure'))
      for (const v of d.violations || []) if (v?.quotaId) quotaIds.push(String(v.quotaId));
    if (type.endsWith('RetryInfo')) retryDelayMs = parseDuration(d.retryDelay);
  }
  if (!reason && /api key not valid|API_KEY_INVALID/i.test(message)) reason = 'API_KEY_INVALID';

  let kind: ErrorKind;
  if (status === 429 || err.status === 'RESOURCE_EXHAUSTED') kind = 'rate_limit';
  else if (status === 401 || (reason && KEY_DEAD_REASONS.has(reason))) kind = 'auth';
  else if (status === 403) kind = 'forbidden';
  else if (status === 0 || status === 408 || status >= 500) kind = 'transient';
  else kind = 'client';

  return { kind, message, reason, quotaIds, retryDelayMs };
}

export function googleError(code: number, status: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, status, message, ...extra } };
}
