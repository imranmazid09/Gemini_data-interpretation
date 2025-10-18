// Netlify serverless function - Secure Gemini API Proxy
// Location: /netlify/functions/gemini-proxy.js

// In-memory rate limiter (for single-instance deployment)
// For multi-instance, consider using Netlify Blobs or external service
const rateLimitMap = new Map();

function getRateLimitKey(event) {
  // Use client IP or fallback to user agent
  return (
    event.headers['x-forwarded-for']?.split(',')[0] ||
    event.headers['cf-connecting-ip'] ||
    event.headers['client-ip'] ||
    'unknown'
  );
}

function checkRateLimit(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const userLimit = rateLimitMap.get(key) || { count: 0, resetTime: now + windowMs };

  if (now > userLimit.resetTime) {
    // Reset window
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (userLimit.count >= maxRequests) {
    return false; // Rate limit exceeded
  }

  userLimit.count++;
  rateLimitMap.set(key, userLimit);
  return true;
}

// Validate request payload structure
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'Invalid request body' };
  }

  if (!payload.contents || !Array.isArray(payload.contents)) {
    return { valid: false, error: 'Missing or invalid "contents" array' };
  }

  if (payload.contents.length === 0) {
    return { valid: false, error: 'Contents array cannot be empty' };
  }

  // Validate each content object
  for (const content of payload.contents) {
    if (!content.parts || !Array.isArray(content.parts)) {
      return { valid: false, error: 'Invalid content structure' };
    }
    if (content.parts.length === 0) {
      return { valid: false, error: 'Content parts cannot be empty' };
    }
  }

  return { valid: true };
}

exports.handler = async function (event, context) {
  // Set default timeout
  context.callbackWaitsForEmptyEventLoop = false;

  // === SECURITY CHECKS ===

  // 1. HTTP method validation
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed. Only POST requests are accepted.' })
    };
  }

  // 2. CORS headers - Adjust origin as needed
  const allowedOrigins = [
    'https://inspiring-palmier-cf0dfe.netlify.app',
    'https://main--inspiring-palmier-cf0dfe.netlify.app',
    // Add your custom domain here when ready
  ];
  
  const origin = event.headers['origin'] || event.headers['referer'];
  const isAllowedOrigin = allowedOrigins.some(o => origin?.includes(o));
  
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Type': 'application/json'
  };

  if (isAllowedOrigin) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'OK' })
    };
  }

  // 3. Rate limiting
  const rateLimitKey = getRateLimitKey(event);
  if (!checkRateLimit(rateLimitKey, 10, 60000)) { // 10 requests per 60 seconds
    return {
      statusCode: 429,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'Too many requests. Please wait before trying again.' 
      })
    };
  }

  // 4. Request size validation (max 1MB)
  const contentLength = parseInt(event.headers['content-length'], 10);
  if (contentLength > 1024 * 1024) {
    return {
      statusCode: 413,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Request payload too large. Maximum 1MB.' })
    };
  }

  // === API KEY RETRIEVAL ===
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.error('CRITICAL: GEMINI_API_KEY not configured');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'Server configuration error. Please contact support.' 
      })
    };
  }

  // === REQUEST PROCESSING ===
  try {
    // Parse and validate payload
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (e) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid JSON in request body' })
      };
    }

    // Validate payload structure
    const validation = validatePayload(payload);
    if (!validation.valid) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: validation.error })
      };
    }

    // Call Gemini API
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000) // 30 second timeout
    });

    // Handle API errors
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Gemini API Error (${response.status}):`, errorBody);

      // Map common Gemini errors to user-friendly messages
      let userMessage = 'An error occurred while processing your request.';
      if (response.status === 400) {
        userMessage = 'Invalid request format. Please check your input.';
      } else if (response.status === 401 || response.status === 403) {
        userMessage = 'Authentication failed. Please contact support.';
      } else if (response.status === 429) {
        userMessage = 'API rate limit exceeded. Please try again later.';
      } else if (response.status === 500) {
        userMessage = 'Gemini API is temporarily unavailable. Please try again.';
      }

      return {
        statusCode: response.status >= 500 ? 503 : response.status,
        headers: corsHeaders,
        body: JSON.stringify({ error: userMessage })
      };
    }

    // Parse and return Gemini response
    const data = await response.json();

    // Optional: Log successful requests for analytics (store in environment if needed)
    console.log(`[${new Date().toISOString()}] Successful Gemini call from ${rateLimitKey}`);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(data)
    };

  } catch (error) {
    // Handle timeout or fetch errors
    if (error.name === 'AbortError') {
      console.error('Request timeout:', error.message);
      return {
        statusCode: 504,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Request timeout. Please try again.' })
      };
    }

    console.error('[SERVERLESS_ERROR]', error.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ 
        error: 'An internal server error occurred. Please try again later.' 
      })
    };
  }
};
