// netlify/functions/generateBlogPost.js
// Hỗ trợ cả: scheduled (24h tự động) và manual trigger qua HTTP POST

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SOURCE_URL = "https://wiki.batdongsan.com.vn/tin-tuc";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama3-70b-8192"; // Free tier model
const POSTS_FILE = path.join(__dirname, "../../src/posts.json");

// ─── HELPERS ───────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const options = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      },
    };
    const req = client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

function postJson(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error("Invalid JSON: " + d.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Groq timeout")); });
    req.write(body);
    req.end();
  });
}

// ─── STEP 1: CRAWL DANH SÁCH BÀI VIẾT ────────────────────────────────────

async function crawlArticleList() {
  console.log("🔍 Crawling:", SOURCE_URL);
  const html = await fetchUrl(SOURCE_URL);

  // Parse thủ công - tìm các thẻ <a> chứa bài viết
  const articles = [];

  // Regex tìm link bài viết trong danh sách tin tức
  const linkPattern = /href="(https?:\/\/wiki\.batdongsan\.com\.vn\/tin-tuc\/[^"]+)"/g;
  const titlePattern = /<h[2-4][^>]*>([^<]{10,200})<\/h[2-4]>/g;

  let match;
  const links = new Set();

  while ((match = linkPattern.exec(html)) !== null) {
    const url = match[1];
    if (!links.has(url) && !url.endsWith("/tin-tuc") && !url.includes("?")) {
      links.add(url);
    }
  }

  // Cũng thử tìm pattern phổ biến của các CMS
  const altPattern = /href="(\/tin-tuc\/[^"?#]+)"/g;
  while ((match = altPattern.exec(html)) !== null) {
    const url = "https://wiki.batdongsan.com.vn" + match[1];
    if (!links.has(url)) links.add(url);
  }

  // Lấy tối đa 10 link đầu tiên
  const linkArray = Array.from(links).slice(0, 10);
  console.log(`📋 Tìm thấy ${linkArray.length} bài viết`);

  return linkArray.map((url) => ({ url, title: "" }));
}

// ─── STEP 2: CRAWL NỘI DUNG BÀI VIẾT ────────────────────────────────────

async function crawlArticleContent(url) {
  console.log("📄 Crawling article:", url);
  const html = await fetchUrl(url);

  // Extract title
  let title = "";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/\s*[-|]\s*.*$/, "").trim();

  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) title = h1Match[1].trim();

  // Extract meta description
  let description = "";
  const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
  if (descMatch) description = descMatch[1];

  // Extract main content - loại bỏ HTML tags
  let content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Lấy đoạn content có liên quan (bỏ phần header/footer lặp lại)
  // Tìm đoạn text dài nhất có ý nghĩa
  const sentences = content.split(/[.!?]\s+/).filter((s) => s.length > 20);
  const relevantContent = sentences.slice(0, 30).join(". ");

  return {
    url,
    title: title || "Bài viết bất động sản",
    description,
    content: relevantContent.slice(0, 3000), // Giới hạn 3000 chars để fit Groq context
  };
}

// ─── STEP 3: GENERATE BLOG POST VỚI GROQ ─────────────────────────────────

async function generateWithGroq(articleData, groqApiKey) {
  console.log("🤖 Generating with Groq:", articleData.title);

  const prompt = `Bạn là chuyên gia bất động sản Việt Nam. Dựa trên bài viết nguồn dưới đây, hãy viết một bài blog chuyên sâu, hấp dẫn bằng tiếng Việt.

THÔNG TIN NGUỒN:
Tiêu đề: ${articleData.title}
Mô tả: ${articleData.description}
Nội dung: ${articleData.content}
URL gốc: ${articleData.url}

YÊU CẦU BÀI BLOG:
1. Viết lại hoàn toàn, KHÔNG sao chép nguyên văn
2. Thêm phân tích chuyên sâu, góc nhìn mới
3. Độ dài: 600-900 từ
4. Cấu trúc: Tiêu đề hấp dẫn, mở đầu thu hút, 3-4 phần chính, kết luận actionable
5. Tone: Chuyên nghiệp nhưng dễ hiểu, có tính thực tiễn cao
6. Thêm lời khuyên cho người đọc

TRẢ VỀ JSON với format CHÍNH XÁC sau (không có text ngoài JSON):
{
  "title": "Tiêu đề bài blog hấp dẫn",
  "summary": "Tóm tắt 1-2 câu",
  "tags": ["tag1", "tag2", "tag3"],
  "content": "Nội dung đầy đủ dạng HTML với các thẻ <h2>, <p>, <ul>, <li>",
  "readTime": 5
}`;

  const response = await postJson(
    GROQ_API_URL,
    {
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2048,
    },
    {
      Authorization: `Bearer ${groqApiKey}`,
    }
  );

  if (response.error) {
    throw new Error("Groq API error: " + JSON.stringify(response.error));
  }

  const rawText = response.choices?.[0]?.message?.content || "";

  // Parse JSON từ response
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Không tìm thấy JSON trong response Groq");

  const parsed = JSON.parse(jsonMatch[0]);
  return parsed;
}

// ─── STEP 4: LƯU BÀI VIẾT ─────────────────────────────────────────────────

function loadPosts() {
  try {
    if (fs.existsSync(POSTS_FILE)) {
      return JSON.parse(fs.readFileSync(POSTS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Error loading posts:", e.message);
  }
  return { posts: [], publishedUrls: [] };
}

function savePosts(data) {
  fs.writeFileSync(POSTS_FILE, JSON.stringify(data, null, 2), "utf-8");
  console.log(`💾 Đã lưu ${data.posts.length} bài viết`);
}

function isAlreadyPublished(url, data) {
  return data.publishedUrls.includes(url);
}

// ─── MAIN HANDLER ──────────────────────────────────────────────────────────

async function runGeneration(groqApiKey) {
  const data = loadPosts();
  console.log(`📚 Hiện có ${data.posts.length} bài, ${data.publishedUrls.length} URL đã dùng`);

  // Crawl danh sách bài viết mới
  const articleList = await crawlArticleList();

  // Tìm bài chưa đăng
  const newArticles = articleList.filter((a) => !isAlreadyPublished(a.url, data));

  if (newArticles.length === 0) {
    return { success: true, message: "Không có bài viết mới để đăng", generated: 0 };
  }

  console.log(`✨ ${newArticles.length} bài mới chưa đăng, xử lý bài đầu tiên...`);

  // Lấy bài đầu tiên chưa đăng
  const target = newArticles[0];

  // Crawl nội dung
  const articleContent = await crawlArticleContent(target.url);

  if (!articleContent.content || articleContent.content.length < 100) {
    // Đánh dấu đã xử lý để skip lần sau
    data.publishedUrls.push(target.url);
    savePosts(data);
    return { success: false, message: "Không đọc được nội dung bài viết: " + target.url };
  }

  // Generate với Groq
  const generated = await generateWithGroq(articleContent, groqApiKey);

  // Tạo post object
  const newPost = {
    id: Date.now().toString(),
    title: generated.title || articleContent.title,
    summary: generated.summary || "",
    content: generated.content || "",
    tags: generated.tags || ["bất động sản"],
    readTime: generated.readTime || 5,
    sourceUrl: target.url,
    sourceTitle: articleContent.title,
    publishedAt: new Date().toISOString(),
    slug: slugify(generated.title || articleContent.title),
  };

  // Lưu
  data.posts.unshift(newPost); // Mới nhất lên đầu
  data.publishedUrls.push(target.url);
  savePosts(data);

  console.log(`✅ Đã đăng: "${newPost.title}"`);
  return { success: true, message: "Đã tạo bài thành công", post: newPost, generated: 1 };
}

function slugify(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

// ─── NETLIFY HANDLER ───────────────────────────────────────────────────────

exports.handler = async (event, context) => {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "GROQ_API_KEY chưa được cấu hình trong Netlify Environment Variables" }),
    };
  }

  // Xác thực cho manual trigger (HTTP POST)
  if (event.httpMethod === "POST") {
    const MANUAL_SECRET = process.env.MANUAL_SECRET || "batdongsan-secret";
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (_) {}

    if (body.secret !== MANUAL_SECRET) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Unauthorized. Cần truyền secret đúng." }),
      };
    }
  }

  try {
    const result = await runGeneration(GROQ_API_KEY);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error("❌ Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
