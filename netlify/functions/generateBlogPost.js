const Parser = require('rss-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});
//const parser = new Parser();
//const RSS_FEED = 'https://vnexpress.net/rss/bat-dong-san.rss';
const RSS_FEED = 'https://dantri.com.vn/rss/bat-dong-san.rss';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'mixtral-8x7b-32768'; // Fast & accurate

exports.handler = async (event) => {
  try {
    // Parse RSS feed
    const feed = await parser.parseURL(RSS_FEED);
    const latestArticle = feed.items[0];

    if (!latestArticle) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'No articles found' }),
      };
    }

    // Extract content
    const title = latestArticle.title;
    const link = latestArticle.link;
    const summary = latestArticle.contentSnippet || latestArticle.summary;

    // Call Groq API to rewrite summary
    const rewrittenSummary = await callGroqAPI(summary);

    // Create blog post object
    const blogPost = {
      id: Date.now(),
      title: title,
      originalLink: link,
      originalSummary: summary,
      rewrittenContent: rewrittenSummary,
      createdAt: new Date().toISOString(),
      source: 'vnexpress.net',
    };

    // Load existing posts
    const postsFilePath = path.join(__dirname, '../../src/posts.json');
    let posts = [];
    
    if (fs.existsSync(postsFilePath)) {
      const fileContent = fs.readFileSync(postsFilePath, 'utf8');
      posts = JSON.parse(fileContent);
    }

    // Add new post (keep last 50)
    posts.unshift(blogPost);
    posts = posts.slice(0, 50);

    // Write back to posts.json
    fs.writeFileSync(postsFilePath, JSON.stringify(posts, null, 2));

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        post: blogPost,
        totalPosts: posts.length,
      }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// Call Groq API to rewrite content
async function callGroqAPI(text) {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a professional blog writer. Rewrite the given text in a clear, engaging way. Keep it 150-200 words.',
          },
          {
            role: 'user',
            content: `Rewrite this article summary in a more engaging way:\n\n${text}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Groq API error: ${error.error?.message || response.status}`);
    }

    const result = await response.json();
    return result.choices[0].message.content;
  } catch (error) {
    console.error('Groq error:', error);
    return text; // Fallback to original if API fails
  }
}
