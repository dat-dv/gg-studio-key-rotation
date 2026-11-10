/**
 * Model làm được việc gì -> quyết định gọi qua endpoint nào.
 *   chat      : ra text. OpenAI /v1/chat/completions hoặc native :generateContent
 *   embedding : vector. OpenAI /v1/embeddings hoặc native :embedContent / :batchEmbedContents
 *   tts       : ra audio. Chỉ native :generateContent (responseModalities: ["AUDIO"])
 *   image     : ra ảnh. Chỉ native :generateContent (responseModalities: ["IMAGE"])
 *   other     : model sinh media khác (nhạc, video...). Chỉ native :generateContent
 */
export const CAPABILITIES = ['chat', 'embedding', 'tts', 'image', 'other'] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Endpoint client đang gọi. */
export type Operation = 'openai-chat' | 'openai-embeddings' | 'generate' | 'embed';

export function isCapability(v: unknown): v is Capability {
  return typeof v === 'string' && (CAPABILITIES as readonly string[]).includes(v);
}

/** Đoán capability từ tên hiển thị, model id và category trên AI Studio. Sửa tay được trên UI. */
export function inferCapability(l: { displayName: string; modelId: string; category: string }): Capability {
  const s = `${l.displayName} ${l.modelId}`.toLowerCase();
  const cat = l.category.trim().toLowerCase();
  if (/\btts\b/.test(s)) return 'tts';
  if (/embedding/.test(s)) return 'embedding';
  if (/image|imagen|nano banana/.test(s)) return 'image';
  if (cat.startsWith('multi-modal') || /lyria|veo|omni/.test(s)) return 'other';
  return 'chat';
}

const ALLOWED: Record<Operation, Capability[]> = {
  'openai-chat': ['chat'],
  'openai-embeddings': ['embedding'],
  generate: ['chat', 'tts', 'image', 'other'],
  embed: ['embedding'],
};

const HOW_TO: Record<Capability, string> = {
  chat: 'POST /v1/chat/completions hoặc /v1beta/models/{model}:generateContent',
  embedding: 'POST /v1/embeddings hoặc /v1beta/models/{model}:embedContent',
  tts: 'POST /v1beta/models/{model}:generateContent với generationConfig.responseModalities = ["AUDIO"]',
  image: 'POST /v1beta/models/{model}:generateContent với generationConfig.responseModalities = ["IMAGE"]',
  other: 'POST /v1beta/models/{model}:generateContent',
};

export const CAPABILITY_LABEL: Record<Capability, string> = {
  chat: 'chat / text',
  embedding: 'embedding',
  tts: 'text-to-speech',
  image: 'sinh ảnh',
  other: 'sinh media khác',
};

/** Nhãn và gợi ý endpoint hiện trên dashboard (tab Limits, form và hàng chi tiết client key). */
export const CAPABILITY_UI: Record<Capability, { label: string; how: string }> = {
  chat: { label: 'Chat / text', how: '/v1/chat/completions hoặc :generateContent' },
  embedding: { label: 'Embedding', how: '/v1/embeddings hoặc :embedContent' },
  tts: { label: 'TTS (giọng nói)', how: 'chỉ :generateContent, responseModalities ["AUDIO"]' },
  image: { label: 'Sinh ảnh', how: 'chỉ :generateContent, responseModalities ["IMAGE"]' },
  other: { label: 'Media khác', how: 'chỉ :generateContent' },
};

/** null = model gọi được qua endpoint này; ngược lại là thông báo lỗi kèm cách gọi đúng. */
export function capabilityMismatch(cap: Capability, op: Operation, model: string): string | null {
  if (ALLOWED[op].includes(cap)) return null;
  return `Model "${model}" là model ${CAPABILITY_LABEL[cap]}, không gọi qua endpoint này được. Hãy gọi: ${HOW_TO[cap].replace('{model}', model)}`;
}
