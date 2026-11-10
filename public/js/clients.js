// Tab "Client keys": form tạo/sửa key, bảng key, hàng chi tiết (thông tin + xem lại key + lệnh mẫu).
let clients = [];
let editingClient = null;
let openClient = null; // id của key đang mở hàng chi tiết
const shownTokens = new Map(); // id -> key đầy đủ đang hiện (vừa tạo hoặc đã bấm Hiện), chỉ giữ trong RAM của tab này
const usableLimits = () => state.limits.filter((l) => !l.unavailableReason);
function renderClientModels(selected = []) {
  const sel = new Set(selected);
  $('#clientModels').innerHTML = usableLimits().map((l) => `<label title="${esc(l.modelId)}"><input type="checkbox" value="${esc(l.modelId)}" ${sel.has(l.modelId) ? 'checked' : ''} /> ${esc(l.displayName)}</label>`).join('');
  renderPurposes();
}
const checkedModels = () => [...document.querySelectorAll('#clientModels input:checked')].map((i) => i.value);
const setChecked = (pick) => { document.querySelectorAll('#clientModels input').forEach((i) => (i.checked = pick(i.value))); renderPurposes(); };
$('#clientAll').onclick = () => setChecked(() => true);
$('#clientNone').onclick = () => setChecked(() => false);
/** Hàng "Mục đích": mỗi loại model (chat, embedding, TTS...) một nút, sáng lên khi các model đang tick đúng bằng loại đó. */
function renderPurposes() {
  const picked = new Set(checkedModels());
  const groups = Object.keys(CAPS)
    .map((cap) => [cap, usableLimits().filter((l) => l.capability === cap).map((l) => l.modelId)])
    .filter(([, ids]) => ids.length);
  $('#clientPurposes').innerHTML = groups.map(([cap, ids]) => {
    const on = picked.size === ids.length && ids.every((m) => picked.has(m));
    return `<button class="btn sm chip${on ? ' on' : ''}" data-cap="${cap}" title="${esc(CAPS[cap].how)}">${esc(CAPS[cap].label)} <span class="hint">${ids.length}</span></button>`;
  }).join('') || '<span class="hint">Chưa có model dùng được trong bảng Limits.</span>';
}
$('#clientPurposes').onclick = (e) => {
  const b = e.target.closest('[data-cap]');
  if (!b) return;
  const off = b.classList.contains('on'); // bấm lại nút đang sáng = bỏ chọn
  const ids = new Set(usableLimits().filter((l) => l.capability === b.dataset.cap).map((l) => l.modelId));
  setChecked((m) => !off && ids.has(m));
};
$('#clientModels').onchange = renderPurposes;

/**
 * Giới hạn hôm nay của một client key. Client key không có hạn mức riêng: nó gọi được tới khi pool key Google
 * hết RPD cho các model nó được phép dùng, nên con số ở đây là của pool và dùng chung giữa các client.
 */
function clientQuota(c) {
  const pool = state.keys.filter((k) => k.enabled);
  const limits = c.allowedModels.length
    ? c.allowedModels.map((m) => state.limits.find((l) => l.modelId === m)).filter(Boolean)
    : usableLimits();
  const rows = limits.map((l) => {
    const used = pool.reduce((s, k) => s + usageOf(k.id, l.modelId).rpd, 0);
    const blocked = !!l.unavailableReason;
    return {
      l,
      mine: c.usedByModel?.[l.modelId] || 0,
      used,
      total: l.rpd == null ? null : l.rpd * pool.length,
      // còn lại tính theo từng key: key đã vượt limit không được bù bằng key khác
      left: blocked ? 0 : l.rpd == null ? (pool.length ? null : 0) : pool.reduce((s, k) => s + Math.max(0, l.rpd - usageOf(k.id, l.modelId).rpd), 0),
      okKeys: blocked ? 0 : pool.filter((k) => keyAvailable(k, l)).length,
      keys: pool.length,
    };
  });
  const poolLeft = rows.some((r) => r.left == null) ? null : rows.reduce((s, r) => s + r.left, 0);
  // hạn mức riêng của key (request/ngày, tính chung mọi model); null = không đặt
  const ownLeft = c.dailyLimit == null ? null : Math.max(0, c.dailyLimit - c.requestsToday);
  const left = ownLeft == null ? poolLeft : poolLeft == null ? ownLeft : Math.min(ownLeft, poolLeft);
  return { rows, poolLeft, ownLeft, left };
}
function quotaCell(c) {
  const q = clientQuota(c);
  const cls = q.left === 0 ? 'bad' : 'ok';
  const why = c.dailyLimit == null ? `theo pool · ${q.rows.length} model`
    : q.ownLeft === q.left ? `hạn mức ${fmt(c.requestsToday)} / ${fmt(c.dailyLimit)}`
    : `pool sắp hết · hạn mức ${fmt(c.requestsToday)} / ${fmt(c.dailyLimit)}`;
  return `<span class="badge ${cls}">${q.left == null ? 'Không giới hạn' : fmt(q.left) + ' req'}</span> <span class="hint">${why}</span>`;
}
/** Dòng "Hạn mức riêng" trong hàng chi tiết. */
function ownLimitHtml(c) {
  if (c.dailyLimit == null) return '<span class="hint">Không đặt — key này gọi được tới khi pool hết quota. Bấm Sửa để đặt hạn mức.</span>';
  const left = Math.max(0, c.dailyLimit - c.requestsToday);
  return `<div style="max-width:260px">${meter(c.requestsToday, c.dailyLimit)}</div><span class="hint">${left ? `còn ${fmt(left)} request hôm nay` : 'đã hết: request bị từ chối (429) tới khi reset 00:00 PT'}</span>`;
}
function quotaTable(c) {
  const { rows } = clientQuota(c);
  if (!rows.length) return '<span class="hint">Chưa có model dùng được trong bảng Limits.</span>';
  return `<div class="tablewrap"><table>
    <thead><tr><th>Model</th><th>Key này đã gọi</th><th>Pool đã dùng (RPD)</th><th>Còn gọi được</th><th>Key Google còn dùng được</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><b>${esc(r.l.displayName)}</b><div class="hint mono">${esc(r.l.modelId)}</div></td>
      <td class="num">${r.mine} req</td>
      <td>${meter(r.used, r.total)}</td>
      <td class="num">${r.l.unavailableReason ? `<span class="badge muted">${esc(r.l.unavailableReason)}</span>` : r.left == null ? '∞' : `<b>${fmt(r.left)}</b> req`}</td>
      <td><span class="badge ${r.okKeys === 0 ? 'bad' : r.okKeys < r.keys ? 'warn' : 'ok'}">${r.okKeys} / ${r.keys}</span></td>
    </tr>`).join('')}</tbody></table></div>`;
}
const todayCell = (c) => `${c.requestsToday} req · ${fmt(c.tokensToday)} tok`;
/** Vẽ lại riêng các ô số liệu (không đụng hàng chi tiết đang mở, lệnh mẫu đang chọn). */
function paintClientQuota() {
  for (const c of clients) {
    const row = document.querySelector(`#clientsBody tr[data-client="${c.id}"]`);
    if (!row) continue;
    row.querySelector('[data-c="today"]').textContent = todayCell(c);
    row.querySelector('[data-c="quota"]').innerHTML = quotaCell(c);
  }
  const open = clients.find((c) => c.id === openClient);
  const box = document.querySelector('#clientsBody tr.detail [data-k="quota"]');
  if (open && box) box.innerHTML = quotaTable(open);
  const own = document.querySelector('#clientsBody tr.detail [data-k="own"]');
  if (open && own) own.innerHTML = ownLimitHtml(open);
}
/** Gọi mỗi lần dashboard làm mới (5s) khi đang ở tab này. */
async function refreshClientQuota() {
  try {
    const next = await api('/api/clients');
    const byId = new Map(next.map((c) => [c.id, c]));
    for (const c of clients) Object.assign(c, byId.get(c.id) || {});
  } catch {}
  paintClientQuota();
}

async function loadClients() {
  try { clients = await api('/api/clients'); } catch (e) { return toast(e.message); }
  const name = (id) => state.limits.find((l) => l.modelId === id)?.displayName || id;
  $('#clientAuthHint').textContent = clients.length ? '· gateway đang yêu cầu key' : '· chưa có key nào: gateway đang mở cho mọi request (nếu chưa đặt PROXY_TOKEN)';
  $('#clientsBody').innerHTML = clients.map((c) => `<tr data-client="${c.id}">
    <td><b>${esc(c.name)}</b></td>
    <td><button class="keylink" title="Xem thông tin và cách gọi bằng curl" onclick="toggleClientDetail(${c.id})">${esc(c.tokenPrefix)}… <i>▾</i></button></td>
    <td>${c.allowedModels.length ? c.allowedModels.map((m) => `<span class="badge muted" style="margin:1px">${esc(name(m))}</span>`).join(' ') : '<span class="badge ok">Mọi model</span>'}</td>
    <td class="num" data-c="today">${todayCell(c)}</td>
    <td data-c="quota">${quotaCell(c)}</td>
    <td class="hint">${c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : 'chưa dùng'}</td>
    <td class="row" style="justify-content:flex-end">
      ${c.enabled ? '' : '<span class="badge bad">Tắt</span>'}
      <button class="btn sm" onclick="editClient(${c.id})">Sửa</button>
      <button class="btn sm" onclick="toggleClient(${c.id}, ${!c.enabled})">${c.enabled ? 'Tắt' : 'Bật'}</button>
      <button class="btn sm danger" onclick="delClient(${c.id})">Xoá</button>
    </td></tr>`).join('') || '<tr><td colspan="7" class="hint">Chưa có client key nào.</td></tr>';
  const reopen = openClient; // bảng vừa vẽ lại: mở lại hàng chi tiết đang xem
  openClient = null;
  if (reopen != null && clients.some((c) => c.id === reopen)) toggleClientDetail(reopen, false);
}
function resetClientForm() {
  editingClient = null;
  $('#clientName').value = '';
  $('#clientLimit').value = '';
  $('#clientFormTitle').textContent = 'Tạo key cho nơi khác gọi vào gateway';
  $('#clientSave').textContent = 'Tạo key';
  $('#clientCancel').hidden = true;
  renderClientModels();
}
function editClient(id) {
  const c = clients.find((x) => x.id === id);
  editingClient = id;
  $('#clientName').value = c.name;
  $('#clientLimit').value = c.dailyLimit ?? '';
  $('#clientFormTitle').textContent = `Sửa key "${c.name}"`;
  $('#clientSave').textContent = 'Lưu thay đổi';
  $('#clientCancel').hidden = false;
  $('#clientToken').hidden = true;
  renderClientModels(c.allowedModels);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#clientCancel').onclick = resetClientForm;
$('#clientSave').onclick = async () => {
  const limit = $('#clientLimit').value.trim();
  const body = JSON.stringify({ name: $('#clientName').value, allowedModels: checkedModels(), dailyLimit: limit === '' ? null : Number(limit) });
  try {
    if (editingClient) {
      await api(`/api/clients/${editingClient}`, { method: 'PATCH', body });
      toast('Đã lưu');
    } else {
      const r = await api('/api/clients', { method: 'POST', body });
      shownTokens.set(r.id, r.token);
      showCreated(r);
    }
    resetClientForm();
    loadClients();
  } catch (e) { toast(e.message); }
};
const snippetModels = (allowed) => (allowed.length ? allowed : usableLimits().map((l) => l.modelId));
/** Khối hiện ngay sau khi tạo key: key đầy đủ + lệnh mẫu. */
function showCreated(r) {
  const box = $('#clientToken');
  box.hidden = false;
  renderSnippet(box, {
    token: r.token,
    models: snippetModels(r.allowedModels),
    head: `<b class="ok">Đã tạo key cho "${esc(r.name)}"</b> — copy key bên dưới; sau này bấm vào key trong bảng để xem lại.
      <div class="row" style="margin-top:8px"><code style="font-size:13px;padding:4px 8px">${esc(r.token)}</code><button class="btn sm" data-s="copyToken">Copy key</button></div>`,
  }, () => { box.hidden = true; });
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
/** Bấm vào key trong bảng: mở/đóng hàng chi tiết (thông tin + cách gọi) ngay dưới key đó. */
function toggleClientDetail(id, scroll = true) {
  document.querySelector('#clientsBody tr.detail')?.remove();
  document.querySelectorAll('#clientsBody tr.open').forEach((r) => r.classList.remove('open'));
  if (openClient === id) { openClient = null; return; }
  const c = clients.find((x) => x.id === id);
  const row = document.querySelector(`#clientsBody tr[data-client="${id}"]`);
  if (!c || !row) { openClient = null; return; }
  openClient = id;
  const token = shownTokens.get(id) || null;
  const when = (ts) => (ts ? new Date(ts).toLocaleString() : null);
  const modelList = c.allowedModels.length
    ? c.allowedModels.map((m) => `<code>${esc(m)}</code> <span class="hint">${esc(CAPS[capOf(m)].label)}</span>`).join(' · ')
    : 'Mọi model trong bảng Limits';
  const tr = document.createElement('tr');
  tr.className = 'detail';
  tr.innerHTML = `<td colspan="7">
    <div class="kv">
      <div><span>Tên</span><b>${esc(c.name)}</b></div>
      <div><span>Trạng thái</span>${c.enabled ? '<span class="badge ok">Đang bật</span>' : '<span class="badge bad">Đã tắt</span> <span class="hint">request bị từ chối</span>'}</div>
      <div><span>Tạo lúc</span>${esc(when(c.createdAt) || '—')}</div>
      <div><span>Dùng lần cuối</span>${esc(when(c.lastUsedAt) || 'chưa dùng')}</div>
      <div><span>Hôm nay</span>${c.requestsToday} request · ${fmt(c.tokensToday)} token</div>
      <div class="wide"><span>Hạn mức riêng (request / ngày)</span><div data-k="own">${ownLimitHtml(c)}</div></div>
      <div class="wide"><span>Key</span>${c.revealable
        ? `<div class="row"><code data-k="tok" style="font-size:13px;padding:4px 8px;word-break:break-all"></code><button class="btn sm" data-k="show"></button><button class="btn sm" data-k="copy">Copy key</button></div>`
        : `<code>${esc(c.tokenPrefix)}…</code> <div class="hint">Key này tạo từ bản cũ, server chỉ có mã băm nên không xem lại được. Thay <code>&lt;CLIENT_KEY&gt;</code> trong lệnh mẫu bằng key đã cấp, hoặc tạo key mới để thay.</div>`}</div>
      <div class="wide"><span>Model được phép</span>${modelList}</div>
      <div class="wide"><span>Cách gửi key</span><code>Authorization: Bearer &lt;key&gt;</code> · <code>x-goog-api-key: &lt;key&gt;</code> · <code>?key=&lt;key&gt;</code></div>
    </div>
    <b>Pool key Google hôm nay</b> <span class="hint">— dùng chung với các client khác cùng model; key này không gọi được quá phần còn lại ở đây dù hạn mức riêng còn</span>
    <div data-k="quota" style="margin:6px 0 14px">${quotaTable(c)}</div>
    <b>Lệnh curl mẫu</b>
    <div class="snip"></div></td>`;
  row.after(tr);
  row.classList.add('open');
  const snip = renderSnippet(tr.querySelector('.snip'), { token, models: snippetModels(c.allowedModels) }, () => toggleClientDetail(id));
  if (c.revealable) {
    const k = (n) => tr.querySelector(`[data-k="${n}"]`);
    const fetchToken = async () => shownTokens.get(id) || (await api(`/api/clients/${id}/reveal`)).token;
    const paint = () => { // key đang hiện thì điền luôn vào lệnh mẫu
      const t = shownTokens.get(id) || null;
      k('tok').textContent = t || c.tokenPrefix + '…';
      k('show').textContent = t ? 'Ẩn' : 'Hiện';
      snip.setToken(t);
    };
    k('show').onclick = async () => {
      try {
        if (shownTokens.has(id)) shownTokens.delete(id);
        else shownTokens.set(id, await fetchToken());
        paint();
      } catch (e) { toast(e.message); }
    };
    k('copy').onclick = async () => { try { await navigator.clipboard.writeText(await fetchToken()); toast('Đã copy key'); } catch (e) { toast(e.message); } };
    paint();
  }
  if (scroll) tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function toggleClient(id, enabled) { try { await api(`/api/clients/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }); loadClients(); } catch (e) { toast(e.message); } }
async function delClient(id) { const c = clients.find((x) => x.id === id); if (!confirm(`Xoá key "${c.name}"? Nơi đang dùng key này sẽ bị từ chối ngay.`)) return; await api(`/api/clients/${id}`, { method: 'DELETE' }); loadClients(); }
