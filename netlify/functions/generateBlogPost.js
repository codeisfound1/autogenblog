// netlify/functions/generateBlogPost.js
// Hỗ trợ cả: scheduled (24h tự động) và manual trigger qua HTTP POST

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SOURCE_URL = "https://wiki.batdongsan.com.vn/tin-tuc";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant"; // Free tier model
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

  const systemPrompt = `Bạn là chuyên gia phân tích bất động sản Việt Nam. Nhiệm vụ của bạn là nhận thông tin bài viết gốc và TRẢ VỀ DUY NHẤT một JSON object hợp lệ, không có bất kỳ text nào khác trước hoặc sau JSON. Không dùng markdown, không dùng code block, không giải thích.`;

  const userPrompt = `Dựa trên thông tin bài viết sau, hãy viết một bài blog chuyên sâu bằng tiếng Việt và trả về JSON.

THÔNG TIN NGUỒN:
Tiêu đề: ${articleData.title}
Mô tả: ${articleData.description}
Nội dung tóm tắt: ${articleData.content}

YÊU CẦU:
- Viết lại hoàn toàn, không sao chép nguyên văn
- Thêm phân tích và góc nhìn chuyên sâu
- Độ dài 500-700 từ
- Tone chuyên nghiệp, thực tiễn

QUAN TRỌNG: Chỉ trả về JSON object thuần túy theo đúng format sau, KHÔNG có text nào khác:
{"title":"Tiêu đề bài blog","summary":"Tóm tắt ngắn 1-2 câu","tags":["tag1","tag2","tag3"],"content":"<p>Đoạn mở đầu...</p><h2>Tiêu đề phần 1</h2><p>Nội dung...</p><h2>Tiêu đề phần 2</h2><p>Nội dung...</p><h2>Kết luận</h2><p>Nội dung kết luận và lời khuyên...</p>","readTime":5}`;

  const response = await postJson(
    GROQ_API_URL,
    {
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    },
    {
      Authorization: `Bearer ${groqApiKey}`,
    }
  );

  if (response.error) {
    throw new Error("Groq API error: " + JSON.stringify(response.error));
  }

  const rawText = (response.choices?.[0]?.message?.content || "").trim();
  console.log("📥 Groq raw response (200 chars):", rawText.slice(0, 200));

  return parseGroqResponse(rawText, articleData);
}

// ─── JSON PARSER ROBUST ────────────────────────────────────────────────────

function parseGroqResponse(rawText, articleData) {
  // Thử 1: Parse thẳng nếu là JSON thuần
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && parsed.title) return parsed;
  } catch (_) {}

  // Thử 2: Xóa markdown code block ```json ... ```
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && parsed.title) return parsed;
  } catch (_) {}

  // Thử 3: Tìm JSON object đầu tiên trong text (dùng bộ đếm ngoặc)
  const start = rawText.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let end = -1;
    let inString = false;
    let escape = false;
    for (let i = start; i < rawText.length; i++) {
      const ch = rawText[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end !== -1) {
      try {
        const parsed = JSON.parse(rawText.slice(start, end + 1));
        if (parsed && parsed.title) return parsed;
      } catch (_) {}
    }
  }

  // Thử 4: Extract từng field bằng regex (fallback cuối)
  console.warn("⚠️ JSON parse thất bại, dùng regex fallback");
  const extractField = (key) => {
    const m = rawText.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i"));
    return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : null;
  };
  const extractArray = (key) => {
    const m = rawText.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]+)\\]`, "i"));
    if (!m) return [];
    return m[1].match(/"([^"]+)"/g)?.map((s) => s.replace(/"/g, "")) || [];
  };
  const extractNum = (key) => {
    const m = rawText.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "i"));
    return m ? parseInt(m[1]) : 5;
  };

  const title = extractField("title") || articleData.title;
  const summary = extractField("summary") || articleData.description || "";
  const content = extractField("content") || `<p>${rawText.slice(0, 500)}</p>`;
  const tags = extractArray("tags").length ? extractArray("tags") : ["bất động sản"];
  const readTime = extractNum("readTime");

  if (!title) {
    throw new Error(
      "Không parse được response Groq. Raw: " + rawText.slice(0, 300)
    );
  }

  return { title, summary, content, tags, readTime };
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
