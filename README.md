# GG Studio — Gemini Key Pool Gateway

Gateway nội bộ đứng trước Gemini API: gom nhiều API key free tier (mỗi project một key) thành một pool, tự chọn key còn quota cho từng request, và cấp key riêng cho từng service/người dùng gọi vào theo chuẩn OpenAI.

## Mục đích

Free tier của Gemini API giới hạn theo **project** (ví dụ Gemini 2.5 Flash: 5 request/phút, 20 request/ngày mỗi project). Một project thì quá ít để dùng thật. Gateway này giải quyết bốn việc:

1. **Quản lý key**: paste lệnh curl từ AI Studio, hệ thống tự tách API key, gắn nhãn account + project.
2. **Biết còn bao nhiêu quota**: lưu bảng limit free tier (paste nguyên bảng từ AI Studio) và đếm usage từng key theo từng model.
3. **Tự chọn key**: request tới model nào thì chọn key còn quota cho model đó, chia đều tải; key bị Google từ chối thì tự chuyển key khác.
4. **Cấp quyền cho nơi khác dùng**: tạo client key (`sk-gg-…`), chọn model được phép, bên dùng gọi như OpenAI API.

## Kiến trúc

```mermaid
flowchart LR
    subgraph Clients["Nơi gọi vào"]
        A1["Service nội bộ<br/>(OpenAI SDK)"]
        A2["Script / curl<br/>(Gemini SDK)"]
        A3["Admin<br/>(trình duyệt)"]
    end

    subgraph GW["GG Studio (1 container NestJS)"]
        direction TB
        AUTH["Xác thực client key<br/>+ kiểm tra model được phép"]
        SEL["Chọn key — 100% trong RAM<br/>• key đang bật<br/>• bộ đếm RPM / TPM / RPD<br/>• cooldown"]
        PROXY["Gọi Google<br/>+ failover khi lỗi"]
        Q["Hàng đợi log<br/>(ghi theo lô mỗi 200ms)"]
        UI["UI + Admin API<br/>Keys · Client keys · Quota · Limits · Logs"]
        DB[("SQLite<br/>volume gg-data")]

        AUTH --> SEL --> PROXY
        PROXY -- "kết quả / lỗi 429" --> SEL
        SEL --> Q --> DB
        DB -. "nạp 1 lần lúc khởi động" .-> SEL
        UI <--> DB
    end

    G["Gemini API<br/>generativelanguage.googleapis.com"]

    A1 -- "/v1/chat/completions<br/>Bearer sk-gg-…" --> AUTH
    A2 -- "/v1beta/models/…:generateContent" --> AUTH
    A3 --> UI
    PROXY -- "API key của project được chọn" --> G
```

### Đường đi của một request

1. **Xác thực**: so mã băm của client key với cache trong RAM, kiểm tra model có nằm trong danh sách được phép.
2. **Chọn key** (không gọi database): lọc các key đang bật, bỏ key đang cooldown hoặc đã chạm RPM/TPM/RPD, rồi lấy key **đã dùng ít nhất** cho model đó (hoà thì xoay vòng). Giữ chỗ ngay trong bộ đếm.
3. **Gọi Google** bằng key vừa chọn.
4. **Xử lý kết quả**:

| Google trả về | Gateway làm gì |
|---|---|
| 200 | Cập nhật số token thật, trả kết quả |
| 429 quota theo ngày | Khoá cặp key + model tới 00:00 giờ Pacific, thử key khác |
| 429 quota theo phút | Khoá theo `retryDelay` (mặc định 60s), thử key khác |
| Key không hợp lệ / project bị khoá | Tắt hẳn key, thử key khác |
| 403 khác | Khoá cặp key + model 1 giờ, thử key khác |
| 5xx, lỗi mạng | Không phạt key, thử key khác |
| 400 / 404 | Trả nguyên lỗi cho client, không thử lại |

Thử tối đa `MAX_ATTEMPTS` key cho một request. Hết key thì trả 429 kèm `Retry-After`.

### Vì sao RAM + SQLite, không dùng Redis

- Chọn key trong RAM của chính tiến trình là nhanh nhất có thể: không có lượt gọi mạng nào, kể cả tới Redis.
- SQLite chỉ để **lưu trữ**: log request được ghi theo lô mỗi 200ms, khi khởi động thì nạp bộ đếm và cooldown từ đó. Build lại hay restart thì số liệu lên như cũ.
- Đánh đổi: nếu tiến trình bị kill đột ngột thì mất tối đa ~200ms log cuối. Bộ đếm lệch vài request thì Google trả 429 và gateway tự cooldown, nên không gây lỗi cho client.
- Giới hạn: **chỉ chạy một instance**. Khi cần nhiều replica thì bộ đếm phải dùng chung, lúc đó mới chuyển phần đếm sang Redis.

## Chạy

### Dev

```bash
npm install
npm run start:dev
```

Mở `http://127.0.0.1:3000/`.

### Docker

File `.env` (xem `.env.example`) cần có `ADMIN_TOKEN`, `PROXY_TOKEN`; `HOST_PORT` là cổng mở ra ngoài (mặc định 4041).

```bash
docker compose up -d --build
```

- Từ ngoài vào: `http://<ip-server>:4041/`
- Service cùng docker network: `http://gg-studio:3000`
- Stack khác trên cùng máy (ví dụ Logis): gateway tham gia network dùng chung `proxy_net` với tên `gg-studio`, nên stack nào cũng gắn vào `proxy_net` gọi được `http://gg-studio:3000/v1` mà không đi vòng ra internet. Network này phải có trước khi deploy, tạo một lần bằng `docker network create proxy_net`. Lưu ý `0.0.0.0` chỉ là địa chỉ lắng nghe, container khác không gọi tới nó được.
- Dữ liệu nằm trong volume `gg-data`. `docker compose down` giữ dữ liệu; `docker compose down -v` **xoá** dữ liệu.

### Coolify

1. Tạo Application từ repo này, Build Pack chọn **Docker Compose** (file `docker-compose.yml`).
2. Vào **Environment Variables → Developer view**, dán nội dung file `.env.coolify` (mẫu: `.env.coolify.example`).
3. Deploy. Gateway mở ở `http://<ip-server>:4041/`. Nếu gắn domain trong Coolify thì trỏ domain vào cổng container `3000`.
4. Dữ liệu nằm trong volume `gg-data` khai báo sẵn trong compose, redeploy không mất.
5. Chuyển dữ liệu từ máy dev lên: **Export** ở máy dev, rồi **Import** trên UI của server.

Chỉ chạy **một** replica (bộ đếm quota nằm trong RAM của tiến trình).

## Sử dụng

### 1. Thêm key Google (tab **Keys Google**)

Paste lệnh curl lấy từ AI Studio (hoặc chỉ API key), điền account và project. Mỗi project chỉ nhận một key vì quota tính theo project.

### 2. Cập nhật bảng limit (tab **Limits**)

Copy nguyên bảng Rate limits trên AI Studio, paste vào ô import. Chỉ những model dùng được qua gateway mới được nạp: bỏ qua model có limit 0, nhóm Agents (cần Interactions API) và Live API (WebSocket). Usage không bị ảnh hưởng. Cột alias dùng để khớp tên model client gửi lên (ví dụ `gemini-flash-latest`).

### 3. Cấp key cho nơi dùng (tab **Client keys**)

Nhập tên, tick các model được phép (không tick = mọi model), bấm tạo. Kèm theo là lệnh curl mẫu, chọn được gọi qua **Domain** (từ ngoài vào) hay **Local** (service cùng docker network hoặc cùng máy) và theo chuẩn OpenAI hay Gemini. Địa chỉ mặc định lấy từ `PUBLIC_BASE_URL` / `LOCAL_BASE_URL`, sửa được ngay trên UI; bấm vào **key** ở mỗi dòng để mở thông tin của key (trạng thái, model được phép, lượng dùng hôm nay) kèm lệnh mẫu đúng endpoint cho từng loại model. Trong đó có nút **Hiện** / **Copy key** để xem lại key đầy đủ (key tạo từ bản cũ chỉ có mã băm nên không xem lại được, cần tạo key mới).

**Gateway tự chọn model.** Với client key có tick model, bên gọi không cần biết tên model thật: gửi một tên không có trong bảng limits (ví dụ `auto`, hoặc tên của key) thì gateway thử lần lượt các model của key theo thứ tự trong bảng, model nào hết quota trên mọi key Google (hoặc Google báo không tồn tại) thì sang model kế. Chỉ model hợp với endpoint mới được xét: chat completions không chọn model embedding hay TTS. Header `x-gg-model` trong response cho biết model đã dùng. Nếu bên gọi gửi đúng tên một model có trong bảng thì gateway dùng đúng model đó, không tự đổi. Key không tick model nào thì bắt buộc phải gửi tên model thật.

### 4. Gọi API

Chuẩn OpenAI:

```bash
curl http://<server>:4041/v1/chat/completions \
  -H "Authorization: Bearer sk-gg-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Xin chào"}]}'
```

```python
from openai import OpenAI
client = OpenAI(api_key="sk-gg-...", base_url="http://<server>:4041/v1")
```

Chuẩn Gemini (key gửi qua `x-goog-api-key`):

```bash
curl "http://<server>:4041/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "x-goog-api-key: sk-gg-..." -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Xin chào"}]}]}'
```

| Endpoint | Ghi chú |
|---|---|
| `POST /v1/chat/completions` | OpenAI, có stream |
| `POST /v1/embeddings` | OpenAI |
| `GET /v1/models` | Key bị giới hạn chỉ thấy model của nó |
| `POST /v1beta/models/{model}:generateContent` | Gemini gốc, kể cả `streamGenerateContent`, `embedContent` |
| `GET /healthz` | Healthcheck |

Mã lỗi từ gateway: `401` key sai/bị tắt, `403` model không được phép, `400` model chưa có trong bảng limits, `429` hết quota (xem `Retry-After`).

### 5. Chuyển dữ liệu giữa các máy

Nút **Export** tải về file JSON gồm key Google, client keys, limits, usage, cooldown. Nút **Import** trên máy đích có hai chế độ: gộp thêm, hoặc thay toàn bộ để máy đích y chang file. File chứa API key dạng plaintext, chỉ gửi qua kênh an toàn.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `HOST_PORT` | `4041` | Cổng Docker mở ra ngoài |
| `BIND_ADDR` | `0.0.0.0` | Địa chỉ Docker bind cổng |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Khi chạy trực tiếp bằng Node |
| `ADMIN_TOKEN` | trống | Bảo vệ UI và admin API (`x-admin-token`) |
| `PROXY_TOKEN` | trống | Key chủ gọi proxy, dùng mọi model |
| `MAX_ATTEMPTS` | `4` | Số key tối đa thử cho một request |
| `DB_PATH` | `./data/gg-studio.db` | File SQLite |

Khi chưa đặt `PROXY_TOKEN` và chưa tạo client key nào, proxy mở cho mọi request (tiện dev). Có ít nhất một client key thì bắt buộc phải gửi key.

## Cấu trúc mã nguồn

```
src/
  keys/      key Google + parser lệnh curl
  limits/    bảng limit free tier + parser bảng AI Studio
  clients/   client key cấp cho nơi dùng
  router/    chọn key (quota.service), proxy + failover (gemini-proxy.controller)
  backup/    export / import
  db/        SQLite schema
public/      UI (một file HTML)
```

## Lưu ý

- Số "đã dùng" là số gateway tự đếm. Request gọi thẳng vào project từ AI Studio hay app khác không được đếm; khi đó Google trả 429 và gateway tự cooldown key.
- RPD reset lúc 00:00 giờ Pacific; RPM/TPM tính theo cửa sổ trượt 60 giây.
- Limit free tier do Google đặt và có thể đổi bất cứ lúc nào: paste lại bảng ở tab Limits.
- Điều khoản Google API cấm lách giới hạn sử dụng; gom nhiều account/project để cộng dồn free tier có rủi ro bị khoá key hoặc account.
- API key Google và client key đều lưu plaintext trong SQLite (client key được xác thực qua mã băm, bản plaintext chỉ để xem lại trên UI): giữ kín file DB, file backup và `ADMIN_TOKEN`.
