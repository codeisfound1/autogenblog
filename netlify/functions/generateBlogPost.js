const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
 
const BLOG_URL = 'https://wiki.batdongsan.com.vn/tin-tuc';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'mixtral-8x7b-32768';
 
// Constants
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // ms
const MAX_POSTS = 50;
const TIMEOUT = 10000; // 10 seconds
 
// Logger helper
const logger = {
  info: (msg, data) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, data || ''),
  error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, err?.message || err || ''),
  warn: (msg, data) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, data || ''),
};
 
// Retry helper with exponential backoff
async function retryAsync(fn, retries = MAX_RETRIES, delay = RETRY_DELAY) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        logger.warn(`Retry attempt ${i + 1}/${retries}`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}
 
// Timeout wrapper
async function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}
 
exports.handler = async (event) => {
  try {
    logger.info('🚀 Starting blog post generation');
 
    // Step 1: Scrape article
    const articleData = await retryAsync(() => scrapeBlogPost());
    const { title, link, summary } = articleData;
 
    if (!title) {
      logger.warn('No article found on page');
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Could not find article on the page' }),
      };
    }
 
    logger.info(`✅ Found article: "${title}"`);
 
    // Step 2: Check duplicates
    const postsFilePath = path.join(__dirname, '../../src/posts.json');
    let posts = [];
    
    if (fs.existsSync(postsFilePath)) {
      const fileContent = fs.readFileSync(postsFilePath, 'utf8');
      posts = JSON.parse(fileContent);
    }
 
    const isDuplicate = posts.some(p => p.title.toLowerCase() === title.toLowerCase());
    if (isDuplicate) {
      logger.info('⚠️ Article already exists, skipping');
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: false,
          message: 'Article already exists',
        }),
      };
    }
 
    // Step 3: Rewrite content with Groq
    let rewrittenContent;
    try {
      rewrittenContent = await withTimeout(
        retryAsync(() => callGroqAPI(summary)),
        TIMEOUT
      );
      logger.info('✅ Groq API call succeeded');
    } catch (error) {
      logger.error('⚠️ Groq API failed, using original summary', error);
      rewrittenContent = summary;
    }
 
    // Step 4: Create blog post object
    const blogPost = {
      id: Date.now(),
      title: title.trim(),
      originalLink: link,
      originalSummary: summary,
      rewrittenContent: rewrittenContent,
      createdAt: new Date().toISOString(),
      source: 'batdongsan.com.vn',
      wordCount: rewrittenContent.split(/\s+/).length,
    };
 
    logger.info(`📝 Blog post created: ${blogPost.id}`);
 
    // Step 5: Save to posts.json (atomic write)
    posts.unshift(blogPost);
    posts = posts.slice(0, MAX_POSTS);
 
    // Write atomically (write to temp file first)
    const tempPath = postsFilePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(posts, null, 2));
    fs.renameSync(tempPath, postsFilePath);
    
    logger.info(`💾 Saved to posts.json (total: ${posts.length})`);
 
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        post: blogPost,
        totalPosts: posts.length,
      }),
    };
  } catch (error) {
    logger.error('❌ Fatal error in handler', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};
 
/**
 * Scrape article from BatDongSan Wiki
 * Tries multiple selectors to handle website layout changes
 */
async function scrapeBlogPost() {
  const response = await withTimeout(
    fetch(BLOG_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9',
      },
      timeout: TIMEOUT,
    }),
    TIMEOUT
  );
 
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
 
  const html = await response.text();
  const $ = cheerio.load(html);
 
  // Try multiple selectors for robustness
  const selectors = [
    'div.HomeHighlights_articleRightContent__JKbTW',
    'div.article-right-content',
    'article.main-article',
    'div[class*="article"][class*="content"]',
    'div.news-item:first',
  ];
 
  let articleDiv;
  for (const selector of selectors) {
    articleDiv = $(selector).first();
    if (articleDiv.length) {
      logger.info(`✓ Found article with selector: ${selector}`);
      break;
    }
  }
 
  if (!articleDiv.length) {
    throw new Error('Article container not found - all selectors failed');
  }
 
  // Extract title (try multiple strategies)
  let title = articleDiv.find('h2, h3').first().text().trim();
  if (!title) {
    title = articleDiv.find('a').first().text().trim();
  }
 
  if (!title) {
    throw new Error('Could not extract title');
  }
 
  // Extract link
  let link = articleDiv.find('a').first().attr('href') || '';
  if (link.startsWith('/')) {
    link = 'https://wiki.batdongsan.com.vn' + link;
  }
 
  // Extract summary
  let summary = articleDiv.find('p, span').first().text().trim();
  if (!summary) {
    summary = title; // Fallback
  }
 
  // Clean up text
  title = title.replace(/\s+/g, ' ').trim();
  summary = summary.replace(/\s+/g, ' ').trim();
 
  logger.info('📰 Scraped data:', {
    title: title.substring(0, 50) + '...',
    link: link.substring(0, 50) + '...',
    summaryLength: summary.length,
  });
 
  return {
    title: title || 'No title found',
    link: link,
    summary: summary || title,
  };
}
 
/**
 * Call Groq API to rewrite content
 * @param {string} text - Original text to rewrite
 * @returns {Promise<string>} Rewritten content
 */
async function callGroqAPI(text) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY environment variable is not set');
  }
 
  // Truncate text if too long
  const maxInputLength = 2000;
  const truncatedText = text.substring(0, maxInputLength);
 
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
          content: `Bạn là một nhà viết blog chuyên nghiệp. 
Viết lại nội dung bài viết một cách sáng tạo, hấp dẫn và chuyên nghiệp.
- Dài 150-200 từ
- Bằng tiếng Việt
- Giữ lại thông tin chính yếu
- Tăng tính engaging
- Không có dấu ngoặc kép
- Không lặp lại thông tin`,
        },
        {
          role: 'user',
          content: `Viết lại nội dung sau một cách chuyên nghiệp:\n\n${truncatedText}`,
        },
      ],
      max_tokens: 300,
      temperature: 0.7,
      top_p: 0.9,
    }),
    timeout: TIMEOUT,
  });
 
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData.error?.message || `HTTP ${response.status}`;
    throw new Error(`Groq API error: ${errorMsg}`);
  }
 
  const result = await response.json();
  
  if (!result.choices || !result.choices[0]?.message?.content) {
    throw new Error('Invalid response format from Groq API');
  }
 
  const rewrittenContent = result.choices[0].message.content.trim();
  
  logger.info('📄 Groq rewrite stats:', {
    inputLength: truncatedText.length,
    outputLength: rewrittenContent.length,
    wordCount: rewrittenContent.split(/\s+/).length,
  });
 
  return rewrittenContent;
}
