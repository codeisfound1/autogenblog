// netlify/functions/getPosts.js
// Frontend gọi endpoint này để lấy danh sách bài viết từ Netlify Blobs

const BLOB_KEY = "posts-data";

async function getStore() {
  const { getStore } = await import("@netlify/blobs");
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) {
    return getStore({ name: "blog", siteID, token });
  }
  return getStore("blog");
}

exports.handler = async function(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const store = await getStore();
    const raw = await store.get(BLOB_KEY);
    const data = raw ? JSON.parse(raw) : { posts: [] };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
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
