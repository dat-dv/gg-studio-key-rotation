// Trang /logs: request đi qua gateway, mới nhất trước, phân trang phía server.
// Trang hiện tại nằm trên URL (?page=&pageSize=) để tải lại / gửi link vẫn đúng chỗ.
const logsState = (() => {
  const q = new URLSearchParams(location.search);
  return { page: Math.max(1, Number(q.get('page')) || 1), pageSize: Number(q.get('pageSize')) || 50, pages: 1 };
})();

async function loadLogs() {
  const r = await api(`/api/logs?page=${logsState.page}&pageSize=${logsState.pageSize}`);
  logsState.page = r.page;
  logsState.pageSize = r.pageSize;
  logsState.pages = r.pages;

  const q = new URLSearchParams();
  if (r.page > 1) q.set('page', r.page);
  if (r.pageSize !== 50) q.set('pageSize', r.pageSize);
  history.replaceState(null, '', location.pathname + (q.size ? `?${q}` : ''));

  const cls = { ok: 'ok', pending: 'muted', rate_limited: 'warn', client_error: 'bad', auth_error: 'bad', upstream_error: 'warn', network_error: 'warn', error: 'bad' };
  $('#logsBody').innerHTML = r.items.map((l) => `<tr>
    <td class="num hint">${new Date(l.ts).toLocaleString()}</td>
    <td>${esc(l.client || '—')}</td>
    <td>${esc(l.account)} / ${esc(l.project)}</td>
    <td class="mono">${esc(l.modelId)}${l.requestedModel && l.requestedModel !== l.modelId ? ` <span class="hint">(gọi: ${esc(l.requestedModel)})</span>` : ''}</td>
    <td><span class="badge ${cls[l.status] || ''}">${esc(l.status)}${l.httpStatus ? ' ' + l.httpStatus : ''}</span></td>
    <td class="num">${fmt(l.tokens)}</td>
    <td class="num">${l.latencyMs != null ? l.latencyMs + 'ms' : ''}</td>
    <td class="hint" style="max-width:380px">${esc(l.error || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="hint">Chưa có request.</td></tr>';

  const from = r.total ? (r.page - 1) * r.pageSize + 1 : 0;
  $('#logsTotal').textContent = r.total ? `${from}–${from + r.items.length - 1} / ${r.total}` : '';
  $('#logsPageInfo').textContent = `Trang ${r.page} / ${r.pages}`;
  $('#logsPageSize').value = String(r.pageSize);
  $('#logsFirst').disabled = $('#logsPrev').disabled = r.page <= 1;
  $('#logsNext').disabled = $('#logsLast').disabled = r.page >= r.pages;
}

function gotoLogsPage(p) {
  logsState.page = p;
  return loadLogs();
}
$('#reloadLogs').onclick = loadLogs;
$('#logsFirst').onclick = () => gotoLogsPage(1);
$('#logsPrev').onclick = () => gotoLogsPage(logsState.page - 1);
$('#logsNext').onclick = () => gotoLogsPage(logsState.page + 1);
$('#logsLast').onclick = () => gotoLogsPage(logsState.pages);
$('#logsPageSize').onchange = (e) => {
  logsState.pageSize = Number(e.target.value);
  return gotoLogsPage(1);
};

page.onReady.push(loadLogs);
