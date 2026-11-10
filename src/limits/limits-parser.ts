export interface ParsedLimit {
  modelId: string;
  displayName: string;
  category: string;
  rpm: number | null; // null = Unlimited
  tpm: number | null;
  rpd: number | null;
  aliases: string[];
  sortOrder: number;
}

const HEADER = new Set(['model', 'category', 'rpm', 'tpm', 'rpd', 'charts']);
const PAIR_RE = /^([\d.]+[KMB]?|-)\s*\/\s*([\d.]+[KMB]?|Unlimited|-)$/i;

/** Alias biết chắc / đoán hợp lý cho tên hiển thị trên AI Studio -> model id thật của API. Có thể sửa trên UI. */
const KNOWN_ALIASES: Record<string, string[]> = {
  'Gemini 3.8 Flash': ['gemini-flash-latest'],
  'Gemini 2 Flash': ['gemini-2.0-flash'],
  'Gemini 2 Flash Lite': ['gemini-2.0-flash-lite'],
  'Nano Banana (Gemini 2.5 Flash Preview Image)': ['gemini-2.5-flash-image'],
  'Gemini 2.5 Flash TTS': ['gemini-2.5-flash-preview-tts'],
  'Gemini 2.5 Pro TTS': ['gemini-2.5-pro-preview-tts'],
  'Gemini Embedding 1': ['gemini-embedding-001'],
  'Gemini 2.5 Flash Native Audio Dialog': ['gemini-2.5-flash-native-audio'],
};

/** Nhóm model gateway không phục vụ được: Agents cần Interactions API, Live API chạy qua WebSocket. */
const UNSUPPORTED_CATEGORIES = new Set(['agents', 'live api']);

/** Vì sao 1 dòng trong bảng AI Studio không dùng được qua gateway; null = dùng được. */
export function unusableReason(l: Pick<ParsedLimit, 'category' | 'rpm' | 'tpm' | 'rpd'>): string | null {
  if (l.rpm === 0 || l.tpm === 0 || l.rpd === 0) return 'không có free tier (limit 0)';
  if (UNSUPPORTED_CATEGORIES.has(l.category.trim().toLowerCase())) return `nhóm "${l.category}" gateway chưa hỗ trợ`;
  return null;
}

export function parseQuotaNumber(v: string): number | null {
  const s = v.trim();
  if (!s || s === '-' || /^unlimited$/i.test(s)) return null;
  const m = s.match(/^([\d.]+)\s*([KMB]?)$/i);
  if (!m) return null;
  const mult = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'B'];
  return Math.round(parseFloat(m[1]) * mult);
}

export function slugifyModel(displayName: string) {
  const inner = displayName.match(/\(([^)]+)\)/);
  const base = inner ? inner[1] : displayName;
  return base
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.\-]/g, '')
    .replace(/-+/g, '-');
}

/**
 * Parse bảng "Rate limits" copy từ AI Studio (mỗi ô 1 dòng hoặc cách nhau bởi tab).
 * Dạng mỗi model: <Tên> <Category> <x / RPM> <x / TPM> <x / RPD>. Phần "Tools" bị bỏ qua.
 * Số bên trái dấu "/" là mức đã dùng trên AI Studio — bỏ qua, chỉ lấy limit bên phải.
 */
export function parseLimitsTable(raw: string): ParsedLimit[] {
  const tokens = raw
    .split(/\r?\n|\t/)
    .map((t) => t.trim())
    .filter(Boolean);

  const out: ParsedLimit[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^tools$/i.test(t)) break;
    if (HEADER.has(t.toLowerCase())) {
      i++;
      continue;
    }
    const [cat, a, b, c] = tokens.slice(i + 1, i + 5);
    const pa = a?.match(PAIR_RE);
    const pb = b?.match(PAIR_RE);
    const pc = c?.match(PAIR_RE);
    if (cat && !PAIR_RE.test(cat) && pa && pb && pc) {
      const modelId = slugifyModel(t);
      if (!seen.has(modelId)) {
        seen.add(modelId);
        out.push({
          modelId,
          displayName: t,
          category: cat,
          rpm: parseQuotaNumber(pa[2]),
          tpm: parseQuotaNumber(pb[2]),
          rpd: parseQuotaNumber(pc[2]),
          aliases: KNOWN_ALIASES[t] || [],
          sortOrder: out.length,
        });
      }
      i += 5;
    } else {
      i++;
    }
  }
  return out;
}

/** Chuẩn hoá model id để match các biến thể -preview-MM-YYYY, -latest, -001, -it, models/... */
export function normalizeModelId(id: string) {
  let s = id.toLowerCase().trim().replace(/^models\//, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/-preview(-\d{2}-\d{4})?$/, '')
      .replace(/-\d{2}-\d{4}$/, '')
      .replace(/-latest$/, '')
      .replace(/-exp(-\d+)?$/, '')
      .replace(/-\d{3}$/, '')
      .replace(/-it$/, '');
  }
  return s;
}
