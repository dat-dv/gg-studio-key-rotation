export interface ParsedCurl {
  apiKey: string | null;
  url: string | null;
  model: string | null;
}

const KEY_RE = /^[A-Za-z0-9._\-]{20,}$/;

/**
 * Lấy API key từ 1 lệnh curl (hoặc chính key được paste thẳng).
 * Hỗ trợ: -H 'X-goog-api-key: ...', --header "x-goog-api-key: ...",
 * Authorization: Bearer ..., và ?key=... trong URL.
 */
export function parseCurl(input: string): ParsedCurl {
  const text = (input || '').replace(/\\\r?\n/g, ' ').trim();

  if (KEY_RE.test(text)) return { apiKey: text, url: null, model: null };

  let apiKey: string | null = null;
  const header = text.match(/x-goog-api-key\s*:\s*([^'"\s]+)/i);
  if (header) apiKey = header[1];
  if (!apiKey) {
    const bearer = text.match(/authorization\s*:\s*bearer\s+([^'"\s]+)/i);
    if (bearer) apiKey = bearer[1];
  }

  const urlMatch = text.match(/https?:\/\/[^\s'"]+/);
  const url = urlMatch ? urlMatch[0] : null;
  if (!apiKey && url) {
    try {
      apiKey = new URL(url).searchParams.get('key');
    } catch {
      /* ignore */
    }
  }

  const modelMatch = url?.match(/\/models\/([^/:?]+)/);
  return { apiKey: apiKey || null, url, model: modelMatch ? modelMatch[1] : null };
}

export function maskKey(k: string) {
  if (k.length <= 12) return '•'.repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
