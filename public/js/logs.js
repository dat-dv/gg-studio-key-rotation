// Tab "Logs": các request gần nhất đi qua gateway.
async function loadLogs() {
  const logs = await api('/api/logs?limit=200');
  const cls = { ok: 'ok', pending: 'muted', rate_limited: 'warn', client_error: 'bad', auth_error: 'bad', upstream_error: 'warn', network_error: 'warn', error: 'bad' };
  $('#logsBody').innerHTML = logs.map((l) => `<tr>
    <td class="num hint">${new Date(l.ts).toLocaleString()}</td>
    <td>${esc(l.client || '—')}</td>
    <td>${esc(l.account)} / ${esc(l.project)}</td>
    <td class="mono">${esc(l.requestedModel)}</td>
    <td><span class="badge ${cls[l.status] || ''}">${esc(l.status)}${l.httpStatus ? ' ' + l.httpStatus : ''}</span></td>
    <td class="num">${fmt(l.tokens)}</td>
    <td class="num">${l.latencyMs != null ? l.latencyMs + 'ms' : ''}</td>
    <td class="hint" style="max-width:380px">${esc(l.error || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="hint">Chưa có request.</td></tr>';
}
$('#reloadLogs').onclick = loadLogs;
