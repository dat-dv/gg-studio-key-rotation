// Trang /keys: danh sách key, thêm key từ lệnh curl hoặc JSON nhiều key, hiện/copy/test/sửa/xoá.
function renderKeys() {
  const accounts = [...new Set(state.keys.map((k) => k.account))];
  $('#accountList').innerHTML = accounts.map((a) => `<option value="${esc(a)}">`).join('');
  $('#keyCount').textContent = `· ${state.keys.length} key, ${accounts.length} account`;
  const rows = [];
  let last = null;
  for (const k of state.keys) {
    if (k.account !== last) {
      last = k.account;
      const n = state.keys.filter((x) => x.account === k.account).length;
      rows.push(`<tr class="group"><td colspan="6">${esc(k.account)} <span class="hint">· ${n} project</span></td></tr>`);
    }
    const cds = cooldownsFor(k.id);
    const status = !k.enabled
      ? `<span class="badge bad" title="${esc(k.disabledReason || '')}">Tắt</span> <span class="hint">${esc((k.disabledReason || '').slice(0, 60))}</span>`
      : cds.length ? `<span class="badge warn" title="${esc(cds.map((c) => `${c.modelId}: ${c.reason} (còn ${dur(c.until - Date.now())})`).join('\n'))}">${cds.length} model cooldown</span>`
      : `<span class="badge ok">Sẵn sàng</span>`;
    const today = Object.values(state.usage[k.id] || {}).reduce((s, u) => s + u.rpd, 0);
    rows.push(`<tr>
      <td>${esc(k.project)}</td>
      <td class="mono"><span id="key-${k.id}">${esc(k.keyMasked)}</span></td>
      <td>${status}</td>
      <td class="num">${today} req</td>
      <td class="hint">${esc(k.note)}</td>
      <td class="row" style="justify-content:flex-end">
        <button class="btn sm" onclick="revealKey(${k.id})">Hiện</button>
        <button class="btn sm" onclick="copyKey(${k.id})">Copy</button>
        <button class="btn sm" onclick="testKey(${k.id})">Test</button>
        <button class="btn sm" onclick="toggleKey(${k.id}, ${!k.enabled})">${k.enabled ? 'Tắt' : 'Bật'}</button>
        ${cds.length ? `<button class="btn sm" onclick="clearCd(${k.id})">Xoá cooldown</button>` : ''}
        <button class="btn sm" onclick="editKey(${k.id})">Sửa</button>
        <button class="btn sm danger" onclick="delKey(${k.id})">Xoá</button>
      </td></tr>`);
  }
  $('#keysBody').innerHTML = rows.join('') || '<tr><td colspan="6" class="hint">Chưa có key nào.</td></tr>';
}

const PARSE_EMPTY = 'Paste curl để xem key được trích ra.';
const ADD_HINT = '1 project = 1 key (quota tính theo project)';
/** Số key trong JSON đang paste; null = đang paste curl / key đơn. */
let bulkCount = null;

/** Đổi form giữa chế độ 1 key và chế độ nạp JSON nhiều key (project lấy từ `name` trong JSON). */
function setBulk(n) {
  bulkCount = n;
  $('#project').disabled = n != null;
  $('#project').placeholder = n != null ? 'lấy từ "name" trong JSON' : 'gg-project-01';
  $('#account').placeholder = n != null ? 'để trống = lấy prefix của name' : 'datdoan.dev';
  $('#addKey').textContent = n != null ? `Import ${n} key` : 'Lưu key';
  $('#addHint').textContent = n != null ? 'Account để trống thì lấy phần trước số thứ tự của name (datvan193-1 → datvan193)' : ADD_HINT;
}

async function updatePreview() {
  const curl = $('#curl').value.trim();
  if (!curl) { setBulk(null); $('#parsePreview').textContent = PARSE_EMPTY; return; }
  try {
    const p = await api('/api/keys/parse', { method: 'POST', body: JSON.stringify({ curl }) });
    if (p.bulk) {
      setBulk(p.bulk.length);
      const bad = p.bulk.filter((b) => !b.keyMasked || !b.project).length;
      $('#parsePreview').innerHTML = `<span class="ok">✓ JSON có ${p.bulk.length} key</span>${bad ? ` <span class="bad">(${bad} dòng thiếu name hoặc key)</span>` : ''}<br>`
        + p.bulk.map((b) => `${esc(b.project || '?')} <code>${esc(b.keyMasked || 'thiếu key')}</code>`).join(' · ');
      return;
    }
    setBulk(null);
    $('#parsePreview').innerHTML = p.found
      ? `<span class="ok">✓ Tìm thấy key</span> <code>${esc(p.keyMasked)}</code>${p.model ? ` · model trong curl: <code>${esc(p.model)}</code>` : ''}`
      : '<span class="bad">✗ Không tìm thấy API key</span>';
  } catch (e) { $('#parsePreview').textContent = e.message; }
}

let parseTimer;
$('#curl').addEventListener('input', () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(updatePreview, 250);
});

$('#keysJsonBtn').onclick = () => $('#keysJsonFile').click();
$('#keysJsonFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  $('#curl').value = await file.text();
  updatePreview();
};

/**
 * Script chạy trong Console của AI Studio để tạo hàng loạt project + key, xuất ra JSON nạp được ở trên.
 * Hỏi prefix, số project và URL trang Projects trước, điền sẵn vào script rồi mới copy.
 */
const SCRIPT_SLOTS = { prefix: "const PREFIX = '';", count: 'const COUNT = 10;', target: "const TARGET = '';" };
const SCRIPT_URL_DEFAULT = 'https://aistudio.google.com/projects';
const lsRead = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsWrite = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/** Đọc form; trả null (kèm toast) nếu có ô nhập sai. */
function scriptOptions() {
  const prefix = $('#scriptPrefix').value.trim();
  if (!prefix) { toast('Chưa nhập prefix.'); return null; }
  const count = Number($('#scriptCount').value);
  if (!Number.isInteger(count) || count < 1 || count > 50) { toast('Số project phải từ 1 đến 50.'); return null; }
  let url;
  try { url = new URL($('#scriptUrl').value.trim() || SCRIPT_URL_DEFAULT); } catch { toast('URL không hợp lệ.'); return null; }
  if (url.protocol !== 'https:' || url.host !== 'aistudio.google.com') { toast('URL phải là trang của https://aistudio.google.com'); return null; }
  lsWrite('createKeyPrefix', prefix); lsWrite('createKeyCount', String(count)); lsWrite('createKeyUrl', url.href);
  return { prefix, count, target: url.href };
}

$('#copyCreateScript').onclick = () => {
  $('#scriptPrefix').value = $('#account').value.trim() || lsRead('createKeyPrefix');
  $('#scriptCount').value = lsRead('createKeyCount') || '10';
  $('#scriptUrl').value = lsRead('createKeyUrl') || SCRIPT_URL_DEFAULT;
  $('#scriptDialog').showModal();
};
$('#scriptCancel').onclick = () => $('#scriptDialog').close();
$('#scriptOpen').onclick = () => { const o = scriptOptions(); if (o) window.open(o.target, '_blank', 'noopener'); };
$('#scriptCopy').onclick = async () => {
  const o = scriptOptions();
  if (!o) return;
  try {
    const res = await fetch('/tools/aistudio-create-project-key.user.js', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Không tải được script (' + res.status + ')');
    let src = await res.text();
    const fill = { prefix: `const PREFIX = ${JSON.stringify(o.prefix)};`, count: `const COUNT = ${o.count};`, target: `const TARGET = ${JSON.stringify(o.target)};` };
    for (const [k, slot] of Object.entries(SCRIPT_SLOTS)) {
      if (!src.includes(slot)) throw new Error('Script thiếu chỗ điền ' + k);
      src = src.replace(slot, () => fill[k]);
    }
    await navigator.clipboard.writeText(src);
    toast(`Đã copy script: ${o.count} project, prefix "${o.prefix}". Dán vào Console của trang Projects.`);
  } catch (e) { toast(e.message); }
};

/**
 * Tự động: mở trang Projects kèm #gg-auto=<json>; userscript đã cài trong trình duyệt chạy ở tab đó, xong thì
 * chuyển tab đó về /keys#gg-result=<json>. Chỉ nhận kết quả mang đúng mã của lần bấm gần nhất (lưu trong
 * localStorage), nếu không thì trang web nào cũng nhét được key lạ vào pool bằng một đường link.
 */
$('#scriptAuto').onclick = () => {
  const o = scriptOptions();
  if (!o) return;
  const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  const url = new URL(o.target);
  url.hash = 'gg-auto=' + encodeURIComponent(JSON.stringify({ prefix: o.prefix, count: o.count, origin: location.origin, nonce }));
  lsWrite('createKeyNonce', nonce);
  if (lsRead('createKeyNonce') !== nonce) return toast('Trình duyệt chặn localStorage nên không chạy tự động được.');
  if (!window.open(url.href, '_blank')) return toast('Trình duyệt chặn mở tab mới. Cho phép popup rồi bấm lại.');
  $('#scriptStatus').textContent = 'Đã mở tab AI Studio. Bấm OK ở hộp xác nhận bên đó; xong nó tự quay về trang Keys và import. Tab đó không tự chạy nghĩa là chưa cài userscript.';
};

/** Tab AI Studio vừa quay về kèm kết quả: xoá khỏi URL ngay rồi import. */
async function takeAutoResult() {
  const m = location.hash.match(/gg-result=([^&]+)/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  let data;
  try { data = JSON.parse(decodeURIComponent(m[1])); } catch { return toast('Kết quả từ AI Studio bị hỏng.'); }
  const nonce = lsRead('createKeyNonce');
  if (!nonce || data.nonce !== nonce) return toast('Bỏ qua kết quả không khớp với lần bấm Tự động gần nhất.');
  try { localStorage.removeItem('createKeyNonce'); } catch {}
  $('#curl').value = JSON.stringify(data.keys, null, 2);
  await updatePreview();
  if (bulkCount) await importKeysJson();
  else toast('AI Studio không trả về key nào.');
}

function resetAddForm() {
  $('#curl').value = ''; $('#project').value = ''; $('#note').value = '';
  setBulk(null);
  $('#parsePreview').textContent = PARSE_EMPTY;
}

async function importKeysJson() {
  const btn = $('#addKey');
  btn.disabled = true;
  try {
    const r = await api('/api/keys/import', { method: 'POST', body: JSON.stringify({ json: $('#curl').value, account: $('#account').value, note: $('#note').value }) });
    if (r.added.length) resetAddForm();
    await refresh();
    toast(`Đã import ${r.added.length} key, đang test…`);
    const tests = await Promise.all(r.added.map((k) => api(`/api/keys/${k.id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, error: e.message }))));
    const failed = r.added.map((k, i) => ({ k, t: tests[i] })).filter((x) => !x.t.ok);
    const lines = [`Import xong: +${r.added.length} key mới, ${r.added.length - failed.length} key test OK.`];
    if (failed.length) lines.push(`\n${failed.length} key test lỗi:\n- ${failed.map((x) => `${x.k.project}: ${x.t.error}`).join('\n- ')}`);
    if (r.skipped.length) lines.push(`\nBỏ qua ${r.skipped.length} dòng:\n- ${r.skipped.map((s) => `${s.project}: ${s.reason}`).join('\n- ')}`);
    alert(lines.join('\n'));
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

$('#addKey').onclick = async () => {
  if (bulkCount != null) return importKeysJson();
  try {
    const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ curl: $('#curl').value, account: $('#account').value, project: $('#project').value, note: $('#note').value }) });
    toast(`Đã lưu ${r.key.account} / ${r.key.project}`);
    resetAddForm();
    await refresh();
    const t = await api(`/api/keys/${r.key.id}/test`, { method: 'POST' });
    toast(t.ok ? `Key hoạt động (${t.latencyMs}ms)` : `Key lỗi: ${t.error}`);
  } catch (e) { toast(e.message); }
};

async function revealKey(id) {
  const el = $('#key-' + id);
  if (el.dataset.revealed) { el.textContent = state.keys.find((k) => k.id === id).keyMasked; delete el.dataset.revealed; return; }
  const { apiKey } = await api(`/api/keys/${id}/reveal`);
  el.textContent = apiKey; el.dataset.revealed = '1';
}
async function copyKey(id) { const { apiKey } = await api(`/api/keys/${id}/reveal`); await navigator.clipboard.writeText(apiKey); toast('Đã copy key'); }
async function testKey(id) { toast('Đang test…'); const t = await api(`/api/keys/${id}/test`, { method: 'POST' }); toast(t.ok ? `OK · ${t.latencyMs}ms` : `Lỗi ${t.status}: ${t.error}`); }
async function toggleKey(id, enabled) { try { await api(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }); refresh(); } catch (e) { toast(e.message); } }
async function clearCd(id) { await api(`/api/cooldowns/${id}`, { method: 'DELETE' }); refresh(); }
async function delKey(id) { const k = state.keys.find((x) => x.id === id); if (!confirm(`Xoá key ${k.account} / ${k.project}? Lịch sử usage của key cũng bị xoá.`)) return; await api(`/api/keys/${id}`, { method: 'DELETE' }); refresh(); }
async function editKey(id) {
  const k = state.keys.find((x) => x.id === id);
  const account = prompt('Account', k.account); if (account == null) return;
  const project = prompt('Project', k.project); if (project == null) return;
  const note = prompt('Ghi chú', k.note); if (note == null) return;
  try { await api(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify({ account, project, note }) }); refresh(); } catch (e) { toast(e.message); }
}

page.onState.push(renderKeys);
takeAutoResult();
