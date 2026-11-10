// Dùng chung: helper DOM/format, gọi admin API, state của dashboard và vòng render.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n == null ? '∞' : n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'K' : String(n);
const dur = (ms) => { ms = Math.max(0, ms); const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0'); return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); };
/** Dữ liệu server nhúng sẵn trong trang (xem UiController). */
const BOOT = JSON.parse($('#boot').textContent);
/** Loại model -> nhãn và cách gọi; nguồn duy nhất là CAPABILITY_UI ở src/limits/capability.ts. */
const CAPS = BOOT.capabilities;
let state = { keys: [], limits: [], usage: {}, cooldowns: [], now: Date.now(), dayEnd: 0 };
/**
 * Mỗi URL là một trang riêng, chỉ nạp script của trang đó. Script của trang đăng ký vào đây
 * để core gọi lại mà không cần biết trang nào đang mở.
 */
const page = {
  /** Vẽ lại mỗi khi state mới về (5s một lần). Chỉ dùng cho phần không có ô đang nhập dở. */
  onState: [],
  /** Chạy một lần khi có state đầu tiên, và chạy lại sau khi import backup. */
  onReady: [],
};
let pageStarted = false;
function pageReady() { page.onReady.forEach((f) => f()); }

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }

async function api(path, opts = {}) {
  let token = '';
  try { token = localStorage.getItem('adminToken') || ''; } catch {}
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}), ...(opts.headers || {}) } });
  if (res.status === 401) {
    const t = prompt('Nhập ADMIN_TOKEN');
    if (t) { try { localStorage.setItem('adminToken', t); } catch {} return api(path, opts); }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(Array.isArray(body.message) ? body.message.join(', ') : body.message || body.error?.message || res.statusText);
  return body;
}

// ---------- data ----------
async function refresh() {
  try {
    state = await api('/api/usage');
    render();
    if (!pageStarted) { pageStarted = true; pageReady(); }
  } catch (e) { toast(e.message); }
}

function cooldownsFor(keyId) { return state.cooldowns.filter((c) => c.keyId === keyId); }
function usageOf(keyId, modelId) { return state.usage[keyId]?.[modelId] || { rpm: 0, tpm: 0, rpd: 0 }; }
function keyAvailable(k, l) {
  if (!k.enabled) return false;
  if (state.cooldowns.some((c) => c.keyId === k.id && (c.modelId === l.modelId || c.modelId === '*'))) return false;
  const u = usageOf(k.id, l.modelId);
  return !(l.rpm != null && u.rpm >= l.rpm) && !(l.rpd != null && u.rpd >= l.rpd) && !(l.tpm != null && u.tpm >= l.tpm);
}

/** Thanh "đã dùng / giới hạn" (trang Quota và hàng chi tiết ở trang Client keys). */
function meter(used, limit) {
  if (limit === 0) return '<span class="muted">0 / 0</span>';
  const pct = limit == null ? 0 : Math.min(100, (used / limit) * 100);
  const cls = pct >= 100 ? 'full' : pct >= 75 ? 'hi' : '';
  return `<div class="meter ${cls}"><span class="num">${fmt(used)} / ${fmt(limit)}</span><div class="bar"><i style="width:${pct}%"></i></div></div>`;
}

function render() {
  renderClock();
  page.onState.forEach((f) => f());
}

function renderClock() {
  const left = state.dayEnd - Date.now();
  $('#clock').textContent = state.dayEnd ? `RPD reset sau ${dur(left)} (00:00 PT)` : '';
  const resetIn = $('#resetIn'); // chỉ có ở trang Quota
  if (resetIn) resetIn.textContent = $('#clock').textContent;
}
