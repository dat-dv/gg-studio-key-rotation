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
 * Hỏi prefix trước, điền sẵn vào script rồi mới copy, nên dán vào Console là chạy luôn.
 */
const PREFIX_SLOT = "const PREFIX = '';";
$('#copyCreateScript').onclick = async () => {
  let last = '';
  try { last = localStorage.getItem('createKeyPrefix') || ''; } catch {}
  const answer = prompt('Name prefix cho project (vd: datvan193). Script sẽ tạo <prefix>-1 … <prefix>-10:', $('#account').value.trim() || last);
  if (answer == null) return;
  const prefix = answer.trim();
  if (!prefix) return toast('Chưa nhập prefix, chưa copy.');
  try {
    const res = await fetch('/tools/aistudio-create-project-key.js', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Không tải được script (' + res.status + ')');
    const src = await res.text();
    if (!src.includes(PREFIX_SLOT)) throw new Error('Script thiếu chỗ điền prefix');
    await navigator.clipboard.writeText(src.replace(PREFIX_SLOT, () => `const PREFIX = ${JSON.stringify(prefix)};`));
    try { localStorage.setItem('createKeyPrefix', prefix); } catch {}
    toast(`Đã copy script với prefix "${prefix}". Dán vào Console ở aistudio.google.com/projects`);
  } catch (e) { toast(e.message); }
};

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
