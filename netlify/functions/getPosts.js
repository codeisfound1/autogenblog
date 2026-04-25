// netlify/functions/getPosts.js
// Frontend gọi endpoint này để lấy danh sách bài viết từ Netlify Blobs

const BLOB_KEY = "posts-data";

exports.handler = async function(event) {
  // Chỉ cho phép GET
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("blog");
    const raw = await store.get(BLOB_KEY);

    const data = raw
      ? JSON.parse(raw)
      : { posts: [], publishedUrls: [] };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60", // Cache 60s
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        posts: data.posts || [],
        total: (data.posts || []).length,
      }),
    };
  } catch (err) {
    console.error("getPosts error:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, posts: [] }),
    };
  }
};
