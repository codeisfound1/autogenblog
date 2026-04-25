# 🏠 BĐS Insight AI – Blog Bất Động Sản Tự Động

Blog tự động crawl bài viết từ `wiki.batdongsan.com.vn`, dùng Groq AI (free) để viết lại thành bài blog chuyên sâu. Deploy trên GitHub + Netlify, hoàn toàn miễn phí.

## ✨ Tính năng

- 🤖 **Tự động 24h**: Netlify Scheduled Functions chạy mỗi ngày
- 🖊️ **Đăng thủ công**: Nhấn nút trên giao diện + nhập secret key
- 🚫 **Không trùng lặp**: Theo dõi URL đã đăng trong `posts.json`
- 🎨 **Giao diện đẹp**: Blog tĩnh, tải nhanh, responsive
- 🆓 **Miễn phí**: Groq free tier + Netlify free plan

---

## 🚀 Hướng dẫn Deploy

### Bước 1 – Lấy Groq API Key (Miễn phí)

1. Vào [console.groq.com](https://console.groq.com)
2. Đăng ký / đăng nhập
3. Vào **API Keys** → **Create API Key**
4. Copy key (bắt đầu bằng `gsk_...`)

### Bước 2 – Push lên GitHub

```bash
# Clone hoặc tạo repo mới
git init
git add .
git commit -m "Initial commit - AI Blog BDS"
git remote add origin https://github.com/YOUR_USERNAME/your-blog.git
git push -u origin main
```

### Bước 3 – Deploy lên Netlify

1. Vào [netlify.com](https://netlify.com) → **Add new site** → **Import an existing project**
2. Chọn repo GitHub vừa tạo
3. **Build settings**:
   - Build command: `echo 'Static build'`
   - Publish directory: `src`
4. Nhấn **Deploy site**

### Bước 4 – Cấu hình Environment Variables

Trong Netlify dashboard → **Site Settings** → **Environment Variables** → **Add variable**:

| Key | Value |
|-----|-------|
| `GROQ_API_KEY` | `gsk_your_key_here` |
| `MANUAL_SECRET` | `your-secret-password` |

### Bước 5 – Bật Scheduled Functions

Netlify Scheduled Functions cần **Netlify Identity** hoặc plan phù hợp.

> ⚠️ **Lưu ý quan trọng về `posts.json`**:
> File `posts.json` trong `src/` là nơi lưu bài viết. Vì Netlify Functions chạy trong serverless environment (không có persistent filesystem), bạn cần một trong các giải pháp sau:

#### Giải pháp A: Netlify Blobs (Khuyến nghị - Free)

Thay thế việc đọc/ghi file bằng Netlify Blobs. Xem [docs.netlify.com/blobs](https://docs.netlify.com/blobs/overview/).

#### Giải pháp B: GitHub API (Đơn giản)

Dùng GitHub API để commit `posts.json` sau mỗi lần tạo bài. Thêm `GITHUB_TOKEN` và `GITHUB_REPO` vào env vars.

#### Giải pháp C: Webhook + Rebuild

Mỗi lần tạo bài → trigger Netlify build → bài mới xuất hiện sau 1-2 phút.

---

## 📁 Cấu trúc file

```
your-blog/
├── netlify/
│   └── functions/
│       └── generateBlogPost.js   # Core: crawl + AI generate + save
├── src/
│   ├── index.html                 # Giao diện blog
│   └── posts.json                 # Database bài viết (JSON)
├── scripts/
│   └── manualGenerate.js          # Test local
├── .env.example                   # Template biến môi trường
├── .gitignore
├── netlify.toml                   # Cấu hình Netlify + schedule
└── package.json
```

## 🛠️ Test local

```bash
# Cài dependencies
npm install

# Tạo file .env
cp .env.example .env
# Điền GROQ_API_KEY vào .env

# Chạy generate thủ công
node scripts/manualGenerate.js

# Hoặc dùng Netlify Dev
npx netlify dev
```

## 🔧 Tùy chỉnh

### Đổi nguồn bài viết
Trong `generateBlogPost.js`, thay đổi:
```js
const SOURCE_URL = "https://wiki.batdongsan.com.vn/tin-tuc";
```

### Đổi model AI
```js
const GROQ_MODEL = "llama3-70b-8192"; // hoặc "mixtral-8x7b-32768"
```

### Đổi lịch tự động
Trong `netlify.toml`:
```toml
[functions.generateBlogPost]
  schedule = "@daily"        # Mỗi ngày
  # schedule = "@hourly"     # Mỗi giờ
  # schedule = "0 8 * * *"   # 8h sáng mỗi ngày
```

## 📝 API Endpoint

**POST** `/.netlify/functions/generateBlogPost`

```json
{
  "secret": "your-manual-secret"
}
```

Response:
```json
{
  "success": true,
  "message": "Đã tạo bài thành công",
  "post": { "title": "...", "slug": "...", ... },
  "generated": 1
}
```

---

## ⚡ Groq Free Tier Limits

- 6,000 tokens/phút
- 14,400 requests/ngày  
- Model `llama3-70b-8192`: Rất mạnh, hoàn toàn miễn phí

Xem thêm: [console.groq.com/settings/limits](https://console.groq.com/settings/limits)
