// Trang /quota: usage theo model của từng key và cooldown.
function renderQuota() {
  const sel = $('#quotaKey');
  const prev = sel.value || 'all';
  const groups = {};
  for (const k of state.keys) (groups[k.account] ||= []).push(k);
  const html = `<option value="all">Tất cả key đang bật (tổng)</option>` +
    Object.entries(groups).map(([a, ks]) => `<optgroup label="${esc(a)}">${ks.map((k) => `<option value="${k.id}">${esc(a)} / ${esc(k.project)}${k.enabled ? '' : ' (tắt)'}</option>`).join('')}</optgroup>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'all';

  const enabled = state.keys.filter((k) => k.enabled);
  const hideZero = $('#hideZero').checked;
  const limits = state.limits.filter((l) => !hideZero || !l.unavailableReason);
  const single = sel.value !== 'all' ? state.keys.find((k) => String(k.id) === sel.value) : null;
  $('#availHead').textContent = single ? 'Trạng thái' : 'Key còn dùng được';

  const totalToday = Object.values(state.usage).flatMap((m) => Object.values(m)).reduce((s, u) => s + u.rpd, 0);
  $('#quotaStats').innerHTML = [
    [enabled.length + ' / ' + state.keys.length, 'key đang bật'],
    [new Set(enabled.map((k) => k.account)).size, 'account'],
    [totalToday, 'request hôm nay'],
    [state.cooldowns.length, 'cặp key·model đang cooldown'],
    ...((state.modelBlocks || []).length ? [[state.modelBlocks.length, 'model Google trả 404']] : []),
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');

  $('#quotaBody').innerHTML = limits.map((l) => {
    const pool = single ? [single] : enabled;
    const sum = pool.reduce((s, k) => { const u = usageOf(k.id, l.modelId); return { rpm: s.rpm + u.rpm, tpm: s.tpm + u.tpm, rpd: s.rpd + u.rpd }; }, { rpm: 0, tpm: 0, rpd: 0 });
    const mul = (v) => v == null ? null : v * pool.length;
    let last;
    const blocked = modelBlock(l.modelId);
    if (l.unavailableReason) last = `<span class="badge muted">${esc(l.unavailableReason)}</span>`;
    else if (blocked) last = `<span class="badge bad" title="${esc(blocked.reason)}">Model 404 · bỏ qua ${dur(blocked.until - Date.now())}</span> <button class="btn sm" onclick="unblockModel('${esc(l.modelId)}')">Thử lại</button>`;
    else if (single) {
      const cd = state.cooldowns.find((c) => c.keyId === single.id && c.modelId === l.modelId);
      last = !single.enabled ? '<span class="badge bad">Key tắt</span>'
        : cd ? `<span class="badge warn" title="${esc(cd.reason)}">Cooldown ${dur(cd.until - Date.now())}</span> <button class="btn sm" onclick="clearCdModel(${single.id}, '${esc(l.modelId)}')">Xoá</button>`
        : keyAvailable(single, l) ? '<span class="badge ok">Dùng được</span>' : '<span class="badge bad">Hết quota</span>';
    } else {
      const ok = pool.filter((k) => keyAvailable(k, l)).length;
      last = `<span class="badge ${ok === 0 ? 'bad' : ok < pool.length ? 'warn' : 'ok'}">${ok} / ${pool.length}</span>`;
    }
    return `<tr><td><b>${esc(l.displayName)}</b><div class="hint mono">${esc(l.modelId)}</div></td><td class="hint">${esc(l.category)}</td>
      <td>${meter(sum.rpm, mul(l.rpm))}</td><td>${meter(sum.tpm, mul(l.tpm))}</td><td>${meter(sum.rpd, mul(l.rpd))}</td><td>${last}</td></tr>`;
  }).join('');
}
$('#quotaKey').onchange = renderQuota;
$('#hideZero').onchange = renderQuota;
async function unblockModel(modelId) { await api(`/api/model-blocks/${encodeURIComponent(modelId)}`, { method: 'DELETE' }); refresh(); }
async function clearCdModel(keyId, modelId) { await api(`/api/cooldowns/${keyId}/${encodeURIComponent(modelId)}`, { method: 'DELETE' }); refresh(); }

page.onState.push(renderQuota);
