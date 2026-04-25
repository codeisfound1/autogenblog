const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BLOG_URL = 'https://wiki.batdongsan.com.vn/tin-tuc';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'mixtral-8x7b-32768';

exports.handler = async (event) => {
  try {
    // Scrape bài viết mới nhất từ URL
    const { title, link, summary } = await scrapeBlogPost();

    if (!title) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Could not find article on the page' }),
      };
    }

    console.log('Found article:', title);

    // Rewrite content với Groq
    const rewrittenSummary = await callGroqAPI(summary);

    // Create blog post object
    const blogPost = {
      id: Date.now(),
      title: title,
      originalLink: link,
      originalSummary: summary,
      rewrittenContent: rewrittenSummary,
      createdAt: new Date().toISOString(),
      source: 'batdongsan.com.vn',
    };

    // Load existing posts
    const postsFilePath = path.join(__dirname, '../../src/posts.json');
    let posts = [];
    
    if (fs.existsSync(postsFilePath)) {
      const fileContent = fs.readFileSync(postsFilePath, 'utf8');
      posts = JSON.parse(fileContent);
    }

    // Kiểm tra không trùng lặp bài viết
    const isDuplicate = posts.some(p => p.title === title);
    if (isDuplicate) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          message: 'Article already exists',
        }),
      };
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

// Scrape bài viết từ website
async function scrapeBlogPost() {
  try {
    const response = await fetch(BLOG_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    // Tìm div với class "HomeHighlights_articleRightContent__JKbTW"
    const articleDiv = $('div.HomeHighlights_articleRightContent__JKbTW').first();
    
    if (!articleDiv.length) {
      throw new Error('Article container not found');
    }

    // Lấy tiêu đề từ link hoặc heading trong div
    const titleElement = articleDiv.find('h2, h3, a').first();
    const title = titleElement.text().trim();

    // Lấy link bài viết
    const linkElement = articleDiv.find('a').first();
    let link = linkElement.attr('href') || '';
    
    // Convert relative URL to absolute URL nếu cần
    if (link.startsWith('/')) {
      link = 'https://wiki.batdongsan.com.vn' + link;
    }

    // Lấy summary/description
    const summaryElement = articleDiv.find('p, span').first();
    const summary = summaryElement.text().trim() || title;

    return {
      title: title || 'No title found',
      link: link,
      summary: summary || title,
    };
  } catch (error) {
    console.error('Scraping error:', error);
    throw error;
  }
}

// Call Groq API
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
            content: 'You are a professional blog writer. Rewrite the given text in a clear, engaging way. Keep it 150-200 words. Write in Vietnamese.',
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
    return text;
  }
}
