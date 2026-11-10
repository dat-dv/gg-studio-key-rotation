import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaDayEnd, quotaDayStart } from '../src/common/time';
import { maskKey, parseCurl } from '../src/keys/curl-parser';
import { accountFromProject, parseKeysJson } from '../src/keys/keys-json';
import { DEFAULT_LIMITS_RAW } from '../src/limits/default-limits';
import { normalizeModelId, parseLimitsTable, parseQuotaNumber, unsupportedReason, unusableReason } from '../src/limits/limits-parser';
import { capabilityMismatch, inferCapability } from '../src/limits/capability';
import { classifyUpstreamError } from '../src/router/upstream-error';

test('parseCurl: header x-goog-api-key, multi-line', () => {
  const p = parseCurl(`curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent" \\
  -H 'Content-Type: application/json' \\
  -H 'X-goog-api-key: AQ.TEST_key-123456789012345678901234' \\
  -X POST -d '{"contents":[{"parts":[{"text":"hi"}]}]}'`);
  assert.equal(p.apiKey, 'AQ.TEST_key-123456789012345678901234');
  assert.equal(p.model, 'gemini-flash-latest');
});

test('parseCurl: ?key= và key trần', () => {
  assert.equal(parseCurl(`curl 'https://x.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSyTESTTESTTESTTESTTEST12345'`).apiKey, 'AIzaSyTESTTESTTESTTESTTEST12345');
  assert.equal(parseCurl('AIzaSyTESTTESTTESTTESTTEST12345').apiKey, 'AIzaSyTESTTESTTESTTESTTEST12345');
  assert.equal(parseCurl('curl https://example.com').apiKey, null);
  assert.equal(maskKey('AIzaSyTESTTESTTESTTESTTEST12345'), 'AIzaSy…2345');
});

test('parseQuotaNumber', () => {
  assert.equal(parseQuotaNumber('250K'), 250000);
  assert.equal(parseQuotaNumber('14.4K'), 14400);
  assert.equal(parseQuotaNumber('1M'), 1000000);
  assert.equal(parseQuotaNumber('Unlimited'), null);
  assert.equal(parseQuotaNumber('0'), 0);
});

test('parseLimitsTable: seed + dạng mỗi ô 1 dòng như copy từ AI Studio', () => {
  const seed = parseLimitsTable(DEFAULT_LIMITS_RAW);
  assert.equal(seed.length, 41);
  const flash = seed.find((l) => l.modelId === 'gemini-2.5-flash')!;
  assert.deepEqual([flash.rpm, flash.tpm, flash.rpd], [5, 250000, 20]);
  const live = seed.find((l) => l.modelId === 'gemini-3.8-live')!;
  assert.deepEqual([live.rpm, live.tpm, live.rpd], [null, 65000, null]);
  assert.equal(seed.find((l) => l.displayName.startsWith('Nano Banana Pro'))!.modelId, 'gemini-3-pro-image');

  const pasted = `Model\nCategory\nRPM\nTPM\nRPD\nCharts\nGemini 3.8 Flash\nText-out models\t\n1 / 5\n6 / 250K\n1 / 20\nGemma 4 26B\nOther models\t\n0 / 30\n0 / 16K\n0 / 14.4K\nTools\nGemini 2\nSearch grounding\t-\t-\t\n0 / 1.5K\n`;
  const rows = parseLimitsTable(pasted);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].modelId, rows[1].rpm, rows[1].tpm, rows[1].rpd], ['gemma-4-26b', 30, 16000, 14400]);
});

test('unusableReason: chỉ giữ model gateway dùng được', () => {
  const all = parseLimitsTable(DEFAULT_LIMITS_RAW);
  const usable = all.filter((l) => !unusableReason(l)).map((l) => l.modelId);
  assert.equal(usable.length, 16);
  for (const id of ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemma-4-31b', 'gemini-embedding-1', 'gemini-2.5-flash-tts'])
    assert.ok(usable.includes(id), id);
  for (const id of ['antigravity', 'gemini-2.5-pro', 'gemini-3.8-live', 'gemini-3.5-transcribe', 'lyria-3-pro'])
    assert.ok(!usable.includes(id), id);
});

test('normalizeModelId', () => {
  assert.equal(normalizeModelId('models/gemini-3-flash-preview'), 'gemini-3-flash');
  assert.equal(normalizeModelId('gemini-2.5-flash-preview-09-2025'), 'gemini-2.5-flash');
  assert.equal(normalizeModelId('gemini-embedding-001'), 'gemini-embedding');
  assert.equal(normalizeModelId('gemini-2.5-flash-preview-tts'), 'gemini-2.5-flash-preview-tts');
});

test('quota day theo giờ Pacific', () => {
  const t = Date.UTC(2026, 10, 10, 20, 0, 0); // 12:00 PST
  assert.equal(quotaDayStart(t), Date.UTC(2026, 10, 10, 8, 0, 0));
  assert.equal(quotaDayEnd(t), Date.UTC(2026, 10, 11, 8, 0, 0));
  const s = Date.UTC(2026, 6, 1, 3, 0, 0); // 30/6 20:00 PDT
  assert.equal(quotaDayStart(s), Date.UTC(2026, 5, 30, 7, 0, 0));
});

test('classifyUpstreamError', () => {
  const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37.5s' } ] } });
  const c = classifyUpstreamError(429, body);
  assert.equal(c.kind, 'rate_limit');
  assert.equal(c.retryDelayMs, 37500);
  assert.match(c.quotaIds[0], /PerDay/);
  assert.equal(classifyUpstreamError(400, JSON.stringify({ error: { message: 'API key not valid. Please pass a valid API key.' } })).kind, 'auth');
  assert.equal(classifyUpstreamError(503, 'overloaded').kind, 'transient');
  assert.equal(classifyUpstreamError(400, JSON.stringify({ error: { message: 'bad field' } })).kind, 'client');
});

test('inferCapability: phân loại model theo tên/category', () => {
  const caps = Object.fromEntries(parseLimitsTable(DEFAULT_LIMITS_RAW).map((l) => [l.modelId, inferCapability(l)]));
  assert.equal(caps['gemini-3.8-flash'], 'chat');
  assert.equal(caps['gemma-4-31b'], 'chat');
  assert.equal(caps['gemini-robotics-er-2-preview'], 'chat');
  assert.equal(caps['gemini-2.5-flash-tts'], 'tts');
  assert.equal(caps['gemini-3.8-flash-lite-tts'], 'tts');
  assert.equal(caps['gemini-embedding-2'], 'embedding');
  assert.equal(caps['gemini-2.5-flash-preview-image'], 'image');
  assert.equal(caps['gemini-3-pro-image'], 'image');
  assert.equal(caps['lyria-3-pro'], 'other');
});

test('capabilityMismatch: chặn model gọi nhầm endpoint', () => {
  assert.equal(capabilityMismatch('chat', 'openai-chat', 'm'), null);
  assert.equal(capabilityMismatch('chat', 'generate', 'm'), null);
  assert.equal(capabilityMismatch('tts', 'generate', 'm'), null);
  assert.equal(capabilityMismatch('embedding', 'openai-embeddings', 'm'), null);
  assert.equal(capabilityMismatch('embedding', 'embed', 'm'), null);
  assert.match(capabilityMismatch('tts', 'openai-chat', 'gemini-2.5-flash-tts')!, /responseModalities = \["AUDIO"\]/);
  assert.ok(capabilityMismatch('image', 'openai-chat', 'm'));
  assert.ok(capabilityMismatch('embedding', 'openai-chat', 'm'));
  assert.ok(capabilityMismatch('embedding', 'generate', 'm'));
  assert.ok(capabilityMismatch('chat', 'openai-embeddings', 'm'));
  assert.ok(capabilityMismatch('chat', 'embed', 'm'));
});

test('unsupportedReason: chỉ chặn nhóm Live API / Agents, không quan tâm quota', () => {
  assert.ok(unsupportedReason('Live API'));
  assert.ok(unsupportedReason(' agents '));
  assert.equal(unsupportedReason('Multi-modal generative models'), null);
  assert.equal(unsupportedReason('Text-out models'), null);
});

test('parseKeysJson: object đánh số, mảng, và nội dung không phải JSON', () => {
  const obj = parseKeysJson('{ "1": { "name": "datvan193-1", "key": "AQ.Ab_TEST-1234567890123456" }, "2": { "name": "datvan193-2", "key": "AQ.Ab_TEST-2234567890123456" } }');
  assert.deepEqual(obj?.map((i) => [i.project, i.apiKey]), [
    ['datvan193-1', 'AQ.Ab_TEST-1234567890123456'],
    ['datvan193-2', 'AQ.Ab_TEST-2234567890123456'],
  ]);
  const arr = parseKeysJson('[{ "project": "p1", "apiKey": "AQ.Ab_TEST-1234567890123456", "account": "acc" }]');
  assert.deepEqual(arr, [{ project: 'p1', apiKey: 'AQ.Ab_TEST-1234567890123456', account: 'acc', note: null }]);
  assert.equal(parseKeysJson("curl 'https://x' -d '{\"a\":1}'"), null);
  assert.equal(parseKeysJson('{ name: broken }'), null);
  assert.equal(parseKeysJson('{}'), null);
  assert.equal(accountFromProject('datvan193-10'), 'datvan193');
  assert.equal(accountFromProject('solo'), 'solo');
});
