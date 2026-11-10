// Khởi động: gắn nav chuyển tab, nạp dữ liệu lần đầu và tự làm mới định kỳ. Nạp sau cùng.
// ---------- tabs ----------
document.querySelectorAll('nav button').forEach((b) => b.onclick = () => {
  currentTab = b.dataset.tab;
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + currentTab));
  if (currentTab === 'logs') loadLogs();
  if (currentTab === 'limits') renderLimits();
  if (currentTab === 'clients') { renderClientModels(); loadClients(); }
  render();
});

refresh();
setInterval(refresh, 5000);
setInterval(renderClock, 1000);
