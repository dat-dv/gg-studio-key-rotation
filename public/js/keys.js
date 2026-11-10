// Trang /keys: danh sách key, thêm key từ lệnh curl, hiện/copy/test/sửa/xoá.
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

let parseTimer;
$('#curl').addEventListener('input', () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(async () => {
    const curl = $('#curl').value.trim();
    if (!curl) { $('#parsePreview').textContent = 'Paste curl để xem key được trích ra.'; return; }
    try {
      const p = await api('/api/keys/parse', { method: 'POST', body: JSON.stringify({ curl }) });
      $('#parsePreview').innerHTML = p.found
        ? `<span class="ok">✓ Tìm thấy key</span> <code>${esc(p.keyMasked)}</code>${p.model ? ` · model trong curl: <code>${esc(p.model)}</code>` : ''}`
        : '<span class="bad">✗ Không tìm thấy API key</span>';
    } catch (e) { $('#parsePreview').textContent = e.message; }
  }, 250);
});

$('#addKey').onclick = async () => {
  try {
    const r = await api('/api/keys', { method: 'POST', body: JSON.stringify({ curl: $('#curl').value, account: $('#account').value, project: $('#project').value, note: $('#note').value }) });
    toast(`Đã lưu ${r.key.account} / ${r.key.project}`);
    $('#curl').value = ''; $('#project').value = ''; $('#note').value = ''; $('#parsePreview').textContent = '';
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
