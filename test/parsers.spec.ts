import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotaDayEnd, quotaDayStart } from '../src/common/time';
import { maskKey, parseCurl } from '../src/keys/curl-parser';
import { DEFAULT_LIMITS_RAW } from '../src/limits/default-limits';
import { normalizeModelId, parseLimitsTable, parseQuotaNumber } from '../src/limits/limits-parser';
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
