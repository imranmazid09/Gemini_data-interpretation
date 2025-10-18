// Netlify serverless function - Secure Gemini API Proxy with Enhanced Error Handling
// Location: /netlify/functions/gemini-proxy.js

const rateLimitMap = new Map();

function getRateLimitKey(event) {
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
    rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (userLimit.count >= maxRequests) {
    return false;
  }

  userLimit.count++;
  rateLimitMap.set(key, userLimit);
  return true;
}

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

// Helper to return JSON responses consistently
function jsonResponse(statusCode, body, corsHeaders = {}) {
  const defaultHeaders = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };

  return {
    statusCode,
    headers: { ...defaultHeaders, ...corsHeaders },
    body: JSON.stringify(body)
  };
}

exports.handler = async function (event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  
  const timestamp = new Date().toISOString();
  const rateLimitKey = getRateLimitKey(event);

  // === LOGGING ===
  console.log(`[${timestamp}] Incoming request: ${event.httpMethod} from ${rateLimitKey}`);

  // === CORS SETUP ===
  const allowedOrigins = [
    'inspiring-palmier-cf0dfe.netlify.app',
    'main--inspiring-palmier-cf0dfe.netlify.app',
  ];
  
  const origin = event.headers['origin'] || event.headers['referer'];
  const isAllowedOrigin = allowedOrigins.some(o => origin?.includes(o));
  
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };

  if (isAllowedOrigin) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
  }

  // === HTTP METHOD CHECK ===
  if (event.httpMethod === 'OPTIONS') {
    console.log(`[${timestamp}] CORS preflight request`);
    return jsonResponse(200, { message: 'OK' }, corsHeaders);
  }

  if (event.httpMethod !== 'POST') {
    console.warn(`[${timestamp}] Invalid method: ${event.httpMethod}`);
    return jsonResponse(405, { error: 'Method Not Allowed. Only POST requests are accepted.' }, corsHeaders);
  }

  // === RATE LIMITING ===
  if (!checkRateLimit(rateLimitKey, 10, 60000)) {
    console.warn(`[${timestamp}] Rate limit exceeded for ${rateLimitKey}`);
    return jsonResponse(429, { error: 'Too many requests. Please wait before trying again.' }, corsHeaders);
  }

  // === REQUEST SIZE CHECK ===
  const contentLength = parseInt(event.headers['content-length'], 10);
  if (contentLength > 1024 * 1024) {
    console.warn(`[${timestamp}] Request too large: ${contentLength} bytes`);
    return jsonResponse(413, { error: 'Request payload too large. Maximum 1MB.' }, corsHeaders);
  }

  // === API KEY CHECK ===
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.error(`[${timestamp}] CRITICAL: GEMINI_API_KEY environment variable not set!`);
    return jsonResponse(500, { 
      error: 'Server configuration error: API key not found. Please check Netlify environment variables.' 
    }, corsHeaders);
  }
  console.log(`[${timestamp}] API key found (length: ${GEMINI_API_KEY.length})`);

  // === REQUEST PROCESSING ===
  try {
    // Parse payload
    let payload;
    try {
      payload = JSON.parse(event.body);
      console.log(`[${timestamp}] Payload parsed successfully`);
    } catch (parseError) {
      console.error(`[${timestamp}] JSON parse error:`, parseError.message);
      return jsonResponse(400, { error: 'Invalid JSON in request body' }, corsHeaders);
    }

    // Validate payload
    const validation = validatePayload(payload);
    if (!validation.valid) {
      console.warn(`[${timestamp}] Payload validation failed: ${validation.error}`);
      return jsonResponse(400, { error: validation.error }, corsHeaders);
    }
    console.log(`[${timestamp}] Payload validation passed`);

    // === CALL GEMINI API ===
    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    
    console.log(`[${timestamp}] Calling Gemini API...`);
    
    const geminiResponse = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });

    console.log(`[${timestamp}] Gemini response status: ${geminiResponse.status}`);

    // === HANDLE GEMINI ERROR ===
    if (!geminiResponse.ok) {
      let errorBody = '';
      try {
        errorBody = await geminiResponse.text();
        console.error(`[${timestamp}] Gemini API error response:`, errorBody);
      } catch (e) {
        console.error(`[${timestamp}] Could not read error response body`);
      }

      let userMessage = 'An error occurred while processing your request.';
      
      if (geminiResponse.status === 400) {
        userMessage = 'Invalid request format. Please check your input.';
      } else if (geminiResponse.status === 401 || geminiResponse.status === 403) {
        userMessage = 'Authentication failed. Please verify your API key and try again.';
      } else if (geminiResponse.status === 429) {
        userMessage = 'Gemini API rate limit exceeded. Please wait a moment and try again.';
      } else if (geminiResponse.status === 500) {
        userMessage = 'Gemini API is experiencing issues. Please try again later.';
      }

      console.error(`[${timestamp}] Returning error to client: ${userMessage}`);
      return jsonResponse(
        geminiResponse.status >= 500 ? 503 : geminiResponse.status,
        { error: userMessage },
        corsHeaders
      );
    }

    // === PARSE GEMINI RESPONSE ===
    let data;
    try {
      data = await geminiResponse.json();
      console.log(`[${timestamp}] Gemini response parsed successfully`);
    } catch (parseError) {
      console.error(`[${timestamp}] Failed to parse Gemini response:`, parseError.message);
      return jsonResponse(502, { 
        error: 'Failed to parse Gemini response. The API may be experiencing issues.' 
      }, corsHeaders);
    }

    // === VALIDATE GEMINI RESPONSE ===
    if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
      console.error(`[${timestamp}] Gemini returned no candidates:`, JSON.stringify(data).substring(0, 200));
      return jsonResponse(502, { 
        error: 'Gemini API returned an empty response. Please try again.' 
      }, corsHeaders);
    }

    console.log(`[${timestamp}] Success! Returning response with ${data.candidates.length} candidate(s)`);

    return jsonResponse(200, data, corsHeaders);

  } catch (error) {
    // === HANDLE TIMEOUT ===
    if (error.name === 'AbortError') {
      console.error(`[${timestamp}] Request timeout (30s exceeded)`);
      return jsonResponse(504, { 
        error: 'Request timeout. The API took too long to respond. Please try again.' 
      }, corsHeaders);
    }

    // === HANDLE OTHER ERRORS ===
    console.error(`[${timestamp}] Unexpected error:`, error.message);
    console.error(`[${timestamp}] Error stack:`, error.stack);
    
    return jsonResponse(500, { 
      error: 'An unexpected error occurred. Please try again later.' 
    }, corsHeaders);
  }
};
