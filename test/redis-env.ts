// Test cần Redis thật (script Lua): REDIS_URL, mặc định redis://127.0.0.1:6379.
//   docker run --rm -p 6379:6379 redis:7-alpine
// Mỗi file test dùng prefix riêng nên chạy song song / dùng chung Redis với dev không đụng nhau.
process.env.REDIS_URL ||= 'redis://127.0.0.1:6379';
process.env.REDIS_PREFIX = `ggtest:${process.pid}:${Date.now()}:`;
