// netlify/functions/generateBlogPost.js
// Dùng Netlify Blobs để lưu trữ persistent (không dùng fs)

const https = require("https");
const http = require("http");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const SOURCE_URL = "https://wiki.batdongsan.com.vn/tin-tuc";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";
const BLOB_KEY = "posts-data";

// ─── NETLIFY BLOBS ─────────────────────────────────────────────────────────

async function getStore() {
  const { getStore } = await import("@netlify/blobs");
  return getStore("blog");
}

async function loadPosts() {
  try {
    const store = await getStore();
    const raw = await store.get(BLOB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.error("Blobs load error:", e.message);
  }
  return { posts: [], publishedUrls: [] };
}

async function savePosts(data) {
  const store = await getStore();
  await store.set(BLOB_KEY, JSON.stringify(data));
  console.log("💾 Đã lưu " + data.posts.length + " bài viết vào Netlify Blobs");
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

function postJson(url, data, headers) {
  headers = headers || {};
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, headers),
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
  console.log("Crawling:", SOURCE_URL);
  const html = await fetchUrl(SOURCE_URL);
  const links = new Set();
  let match;

  const absPattern = /href="(https?:\/\/wiki\.batdongsan\.com\.vn\/tin-tuc\/[^"?#]+)"/g;
  while ((match = absPattern.exec(html)) !== null) {
    if (!match[1].endsWith("/tin-tuc")) links.add(match[1]);
  }

  const relPattern = /href="(\/tin-tuc\/[^"?#]+)"/g;
  while ((match = relPattern.exec(html)) !== null) {
    links.add("https://wiki.batdongsan.com.vn" + match[1]);
  }

  const linkArray = Array.from(links).slice(0, 10);
  console.log("Tim thay " + linkArray.length + " bai viet");
  return linkArray.map((url) => ({ url }));
}

// ─── STEP 2: CRAWL NỘI DUNG BÀI VIẾT ────────────────────────────────────

async function crawlArticleContent(url) {
  console.log("Crawling article:", url);
  const html = await fetchUrl(url);

  let title = "";
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) title = h1Match[1].trim();
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].replace(/\s*[-|].*$/, "").trim();
  }

  let description = "";
  const descMatch = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
  if (descMatch) description = descMatch[1];

  const content = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);

  return { url, title: title || "Bai viet bat dong san", description, content };
}

// ─── STEP 3: GENERATE VỚI GROQ ────────────────────────────────────────────

async function generateWithGroq(articleData, groqApiKey) {
  console.log("Generating:", articleData.title);

  const systemPrompt = "Ban la chuyen gia phan tich bat dong san Viet Nam. Nhiem vu: nhan thong tin bai viet goc va TRA VE DUY NHAT mot JSON object hop le. Khong co text nao khac, khong markdown, khong code block, khong giai thich.";

  const userPrompt = "Viet bai blog chuyen sau tieng Viet dua tren bai viet sau, tra ve JSON.\n\nNGUON:\nTieu de: " + articleData.title + "\nMo ta: " + articleData.description + "\nNoi dung: " + articleData.content + "\n\nChi tra ve JSON object nay, KHONG co gi khac:\n{\"title\":\"Tieu de bai blog\",\"summary\":\"Tom tat 1-2 cau\",\"tags\":[\"tag1\",\"tag2\",\"tag3\"],\"content\":\"<p>Mo dau...</p><h2>Phan 1</h2><p>Noi dung...</p><h2>Phan 2</h2><p>Noi dung...</p><h2>Ket luan</h2><p>Loi khuyen...</p>\",\"readTime\":5}";

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
    { Authorization: "Bearer " + groqApiKey }
  );

  if (response.error) throw new Error("Groq API error: " + JSON.stringify(response.error));

  const rawText = ((response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content) || "").trim();
  console.log("Groq raw (200c):", rawText.slice(0, 200));

  return parseGroqResponse(rawText, articleData);
}

function parseGroqResponse(rawText, articleData) {
  // Thu 1: JSON thuan
  try { const p = JSON.parse(rawText); if (p && p.title) return p; } catch (_) {}

  // Thu 2: Strip markdown fences
  const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { const p = JSON.parse(stripped); if (p && p.title) return p; } catch (_) {}

  // Thu 3: Bracket counter
  const start = rawText.indexOf("{");
  if (start !== -1) {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < rawText.length; i++) {
      const ch = rawText[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end !== -1) {
      try { const p = JSON.parse(rawText.slice(start, end + 1)); if (p && p.title) return p; } catch (_) {}
    }
  }

  // Thu 4: Regex fallback
  console.warn("Dung regex fallback");
  const field = function(k) { const m = rawText.match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "i")); return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : null; };
  const arr = function(k) { const m = rawText.match(new RegExp('"' + k + '"\\s*:\\s*\\[([^\\]]+)\\]', "i")); return m ? (m[1].match(/"([^"]+)"/g) || []).map(function(s) { return s.replace(/"/g, ""); }) : []; };
  const num = function(k) { const m = rawText.match(new RegExp('"' + k + '"\\s*:\\s*(\\d+)', "i")); return m ? parseInt(m[1]) : 5; };

  const title = field("title") || articleData.title;
  if (!title) throw new Error("Khong parse duoc Groq response: " + rawText.slice(0, 300));

  return {
    title: title,
    summary: field("summary") || articleData.description || "",
    content: field("content") || "<p>" + rawText.slice(0, 500) + "</p>",
    tags: arr("tags").length ? arr("tags") : ["bat dong san"],
    readTime: num("readTime"),
  };
}

// ─── SLUGIFY ───────────────────────────────────────────────────────────────

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

// ─── MAIN LOGIC ────────────────────────────────────────────────────────────

async function runGeneration(groqApiKey) {
  const data = await loadPosts();
  console.log("Hien co " + data.posts.length + " bai, " + data.publishedUrls.length + " URL da dung");

  const articleList = await crawlArticleList();
  const newArticles = articleList.filter(function(a) { return !data.publishedUrls.includes(a.url); });

  if (newArticles.length === 0) {
    return { success: true, message: "Khong co bai viet moi de dang", generated: 0 };
  }

  console.log(newArticles.length + " bai chua dang, xu ly bai dau tien...");
  const target = newArticles[0];

  const articleContent = await crawlArticleContent(target.url);

  if (!articleContent.content || articleContent.content.length < 100) {
    data.publishedUrls.push(target.url);
    await savePosts(data);
    return { success: false, message: "Khong doc duoc noi dung: " + target.url };
  }

  const generated = await generateWithGroq(articleContent, groqApiKey);

  const newPost = {
    id: Date.now().toString(),
    title: generated.title || articleContent.title,
    summary: generated.summary || "",
    content: generated.content || "",
    tags: generated.tags || ["bat dong san"],
    readTime: generated.readTime || 5,
    sourceUrl: target.url,
    sourceTitle: articleContent.title,
    publishedAt: new Date().toISOString(),
    slug: slugify(generated.title || articleContent.title),
  };

  data.posts.unshift(newPost);
  data.publishedUrls.push(target.url);
  await savePosts(data);

  console.log("Da dang: " + newPost.title);
  return { success: true, message: "Da tao bai thanh cong", post: newPost, generated: 1 };
}

// ─── NETLIFY HANDLER ───────────────────────────────────────────────────────

exports.handler = async function(event) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Thieu GROQ_API_KEY trong Netlify Environment Variables" }) };
  }

  if (event.httpMethod === "POST") {
    const MANUAL_SECRET = process.env.MANUAL_SECRET || "batdongsan-secret";
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (_) {}
    if (body.secret !== MANUAL_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized. Sai secret key." }) };
    }
  }

  try {
    const result = await runGeneration(GROQ_API_KEY);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error("Error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
