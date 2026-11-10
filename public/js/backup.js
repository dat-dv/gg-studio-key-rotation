// Export / Import toàn bộ dữ liệu (nút trên header).
$('#exportBtn').onclick = async () => {
  if (!confirm('File export chứa API key dạng plaintext. Chỉ lưu và gửi qua kênh an toàn. Tiếp tục?')) return;
  try {
    const data = await api('/api/backup/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `gg-studio-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Đã export ${data.keys.length} key Google, ${(data.clients || []).length} client key, ${data.limits.length} model`);
  } catch (e) { toast(e.message); }
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'gg-studio-backup') throw new Error('File không phải backup của gg-studio');
    const summary = `${data.keys.length} key Google, ${(data.clients || []).length} client key, ${data.limits.length} model, ${(data.logs || []).length} dòng usage`;
    if (!confirm(`Import ${summary} vào server này?`)) return;
    const replace = confirm('Muốn server này Y CHANG file backup?\n\nOK = XOÁ toàn bộ dữ liệu đang có trên server này rồi nạp lại từ file.\nCancel = chỉ gộp thêm, giữ dữ liệu đang có.');
    const r = await api('/api/backup/import' + (replace ? '?mode=replace' : ''), { method: 'POST', body: JSON.stringify(data) });
    await refresh(); renderLimits(); loadClients();
    const skipped = r.keysSkipped.length ? `\n\nBỏ qua ${r.keysSkipped.length} key:\n- ${r.keysSkipped.join('\n- ')}` : '';
    alert(`Import xong (${r.mode === 'replace' ? 'thay toàn bộ' : 'gộp'}): +${r.keysAdded} key mới, ${r.keysUpdated} key cập nhật, ${r.clients} client key, ${r.limits} model, ${r.logs} dòng usage, ${r.cooldowns} cooldown.${skipped}`);
  } catch (e) { toast('Import lỗi: ' + e.message); }
};
