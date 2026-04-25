// scripts/manualGenerate.js
// Dùng để test local: node scripts/manualGenerate.js
// Yêu cầu: GROQ_API_KEY trong .env hoặc environment

const path = require("path");
// only load .env locally for development
if (process.env.NETLIFY === undefined) {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
}

// Load function handler
const { handler } = require("../netlify/functions/generateBlogPost");

async function main() {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const MANUAL_SECRET = process.env.MANUAL_SECRET || "batdongsan-secret";

  if (!GROQ_API_KEY) {
    console.error("❌ Thiếu GROQ_API_KEY trong .env");
    console.log("Tạo file .env với nội dung:");
    console.log("GROQ_API_KEY=your_groq_api_key_here");
    process.exit(1);
  }

  console.log("🚀 Bắt đầu tạo bài viết thủ công...\n");

  const event = {
    httpMethod: "POST",
    body: JSON.stringify({ secret: MANUAL_SECRET }),
  };

  try {
    const result = await handler(event, {});
    const body = JSON.parse(result.body);

    if (result.statusCode === 200) {
      console.log("\n✅ Kết quả:", body.message);
      if (body.post) {
        console.log("📝 Bài viết:", body.post.title);
        console.log("🔗 Nguồn:", body.post.sourceUrl);
      }
    } else {
      console.error("\n❌ Lỗi:", body.error || body.message);
    }
  } catch (err) {
    console.error("❌ Exception:", err.message);
  }
}

main();
