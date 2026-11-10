// Khởi động, nạp sau cùng: lấy dữ liệu lần đầu rồi tự làm mới định kỳ.
refresh();
setInterval(refresh, 5000);
setInterval(renderClock, 1000);
