// Trang /limits: bảng limit free tier và import bảng Rate limits từ AI Studio.
function capSelect(l) {
  const opts = Object.entries(CAPS).map(([k, c]) => `<option value="${k}" ${l.capabilityOverride === k ? 'selected' : ''}>${c.label}</option>`).join('');
  return `<select class="cell" data-f="capability"><option value="" ${l.capabilityOverride ? '' : 'selected'}>Tự đoán: ${CAPS[l.capability].label}</option>${opts}</select>
    <div class="hint">${esc(CAPS[l.capability].how)}</div>`;
}
function renderLimits() {
  const n = (v) => v == null ? '' : v;
  $('#limitsBody').innerHTML = state.limits.map((l) => `<tr data-id="${esc(l.modelId)}"${l.unavailableReason ? ' class="unavail"' : ''}>
    <td><input class="cell" data-f="displayName" value="${esc(l.displayName)}" /><div class="hint">${esc(l.category)}</div>${l.unavailableReason ? `<span class="badge warn" style="margin-top:4px">Chưa dùng được: ${esc(l.unavailableReason)}</span>` : ''}</td>
    <td><input class="cell mono" data-f="newModelId" value="${esc(l.modelId)}" /></td>
    <td><input class="cell mono" data-f="aliases" value="${esc(l.aliases.join(', '))}" /></td>
    <td>${capSelect(l)}</td>
    <td><input class="cell" data-f="rpm" value="${n(l.rpm)}" placeholder="∞" style="width:80px" /></td>
    <td><input class="cell" data-f="tpm" value="${n(l.tpm)}" placeholder="∞" style="width:100px" /></td>
    <td><input class="cell" data-f="rpd" value="${n(l.rpd)}" placeholder="∞" style="width:80px" /></td>
    <td class="row"><button class="btn sm" onclick="saveLimit(this)">Lưu</button><button class="btn sm danger" onclick="delLimit('${esc(l.modelId)}')">Xoá</button></td></tr>`).join('');
}
async function saveLimit(btn) {
  const tr = btn.closest('tr');
  const body = {};
  tr.querySelectorAll('input[data-f], select[data-f]').forEach((i) => body[i.dataset.f] = i.value.trim());
  body.aliases = body.aliases ? body.aliases.split(',').map((s) => s.trim()).filter(Boolean) : [];
  for (const f of ['rpm', 'tpm', 'rpd']) body[f] = body[f] === '' ? null : Number(body[f]);
  try { await api(`/api/limits/${encodeURIComponent(tr.dataset.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('Đã lưu'); await refresh(); renderLimits(); } catch (e) { toast(e.message); }
}
async function delLimit(id) { if (!confirm(`Xoá model ${id}?`)) return; await api(`/api/limits/${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh(); renderLimits(); }
$('#addLimit').onclick = async () => {
  const modelId = prompt('Model id (vd gemini-2.5-flash)'); if (!modelId) return;
  try { await api('/api/limits', { method: 'POST', body: JSON.stringify({ modelId, displayName: modelId }) }); await refresh(); renderLimits(); } catch (e) { toast(e.message); }
};
// Bước 1: xem trước -> model nào dùng được ngay, model nào nạp vào nhưng chưa dùng được và vì sao. Bước 2: người dùng xác nhận mới ghi.
async function importLimits(mode) {
  const raw = $('#limitsRaw').value;
  const box = $('#importPreview');
  let p;
  try { p = await api('/api/limits/preview', { method: 'POST', body: JSON.stringify({ raw, mode }) }); } catch (e) { box.hidden = true; return toast(e.message); }
  const groups = {};
  for (const s of p.unavailable) (groups[s.reason] ||= []).push(s.displayName);
  box.hidden = false;
  box.innerHTML = `
    <b>${mode === 'replace' ? 'Thay toàn bộ bảng limit' : 'Import (merge)'} — xem trước</b>
    <p class="ok" style="margin:8px 0 4px"><b>${p.usable.length} model dùng được ngay:</b></p>
    ${Object.entries(CAPS).map(([k, c]) => {
      const names = p.usable.filter((u) => u.capability === k).map((u) => esc(u.displayName));
      return names.length ? `<div style="margin-bottom:6px"><span class="badge">${esc(c.label)} · ${names.length}</span> <span class="hint">gọi qua ${esc(c.how)}</span><div class="hint">${names.join(' · ')}</div></div>` : '';
    }).join('') || '<div class="hint">(không có)</div>'}
    ${p.unavailable.length ? `<p class="warn" style="margin:12px 0 4px"><b>${p.unavailable.length} model vẫn được nạp nhưng chưa dùng được (router chặn khi bị gọi):</b></p>
      ${Object.entries(groups).map(([reason, names]) => `<div style="margin-bottom:6px"><span class="badge warn">${esc(reason)} · ${names.length}</span><div class="hint">${names.map(esc).join(' · ')}</div></div>`).join('')}` : ''}
    ${p.removed.length ? `<p class="bad" style="margin:12px 0 4px"><b>${p.removed.length} model đang có trong bảng sẽ bị gỡ:</b></p><div class="hint">${p.removed.map((r) => esc(r.displayName)).join(' · ')}</div>` : ''}
    <p class="hint" style="margin:12px 0 8px">Lịch sử usage không bị xoá.${mode === 'replace' ? ' Alias và loại model đã sửa tay sẽ mất.' : ''}</p>
    <div class="row"><button class="btn primary" id="importConfirm">Xác nhận import ${p.usable.length + p.unavailable.length} model</button><button class="btn" id="importCancel">Huỷ</button></div>`;
  $('#importCancel').onclick = () => { box.hidden = true; };
  $('#importConfirm').onclick = async () => {
    try {
      const r = await api('/api/limits/import', { method: 'POST', body: JSON.stringify({ raw, mode }) });
      box.hidden = true;
      $('#limitsRaw').value = '';
      toast(`Đã import ${r.imported} model: ${r.usable} dùng được, ${r.unavailable} chưa dùng được`);
      await refresh(); renderLimits();
    } catch (e) { toast(e.message); }
  };
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('#importMerge').onclick = () => importLimits('merge');
$('#importReplace').onclick = () => importLimits('replace');

page.onReady.push(renderLimits); // bảng có ô nhập nên không vẽ lại theo chu kỳ
