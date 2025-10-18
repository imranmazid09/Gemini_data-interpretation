// Netlify serverless function - Gemini API Proxy with Batch Processing
// Location: /netlify/functions/gemini-proxy.js

const BATCH_SIZE = 25;
const MAX_RETRIES = 2;
const BATCH_PROCESSING_TIMEOUT = 55000; // 55 seconds for all batches (Netlify limit ~60s)

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

// === BATCH PROCESSING FUNCTIONS ===

/**
 * Splits CSV data into batches of 25 rows
 * @param {string} csvText - Raw CSV text
 * @returns {Array} Array of batch objects with headers and rows
 */
function createBatches(csvText) {
  // Debug: Check actual content
  console.log(`[BATCH_PARSE] Raw input length: ${csvText.length}`);
  console.log(`[BATCH_PARSE] First 500 chars (raw): ${JSON.stringify(csvText.substring(0, 500))}`);
  
  // Check for different line endings
  const hasRN = csvText.includes('\r\n');
  const hasR = csvText.includes('\r');
  const hasN = csvText.includes('\n');
  
  console.log(`[BATCH_PARSE] Line endings - CRLF: ${hasRN}, CR: ${hasR}, LF: ${hasN}`);
  
  // Normalize line endings (handle \r\n, \r, \n)
  let normalized = csvText;
  if (hasRN) {
    normalized = csvText.replace(/\r\n/g, '\n');
  } else if (hasR) {
    normalized = csvText.replace(/\r/g, '\n');
  }
  
  console.log(`[BATCH_PARSE] After normalization length: ${normalized.length}`);
  
  // Split and filter empty lines
  const allLines = normalized.split('\n');
  console.log(`[BATCH_PARSE] Total lines after split: ${allLines.length}`);
  
  const lines = allLines.filter(line => line.trim() !== '');
  console.log(`[BATCH_PARSE] Lines after filtering empty: ${lines.length}`);
  
  if (lines.length < 2) {
    console.error(`[BATCH_PARSE] ❌ Not enough lines. Need at least 2 (header + data). Got ${lines.length}`);
    console.error(`[BATCH_PARSE] First 5 lines: ${lines.slice(0, 5).map((l, i) => `${i}: ${l.substring(0, 50)}`).join(' | ')}`);
    return [];
  }

  const headers = lines[0];
  const dataRows = lines.slice(1);
  
  console.log(`[BATCH_PARSE] Headers: ${headers.substring(0, 100)}...`);
  console.log(`[BATCH_PARSE] Data rows: ${dataRows.length}`);
  
  const batches = [];

  for (let i = 0; i < dataRows.length; i += BATCH_SIZE) {
    const batchRows = dataRows.slice(i, i + BATCH_SIZE);
    const batchData = [headers, ...batchRows].join('\n');
    
    batches.push({
      batchNumber: Math.floor(i / BATCH_SIZE) + 1,
      rowStart: i + 1,
      rowEnd: Math.min(i + BATCH_SIZE, dataRows.length),
      data: batchData,
      rowCount: batchRows.length
    });
  }

  console.log(`[BATCH_PARSE] ✅ Created ${batches.length} batches from ${dataRows.length} data rows`);
  batches.forEach((b, idx) => {
    if (idx === 0 || idx === batches.length - 1) {
      console.log(`[BATCH_PARSE] Batch ${b.batchNumber}: rows ${b.rowStart}-${b.rowEnd} (${b.rowCount} rows)`);
    }
  });
  
  return batches;
}

/**
 * Send a single batch to Gemini API
 * @param {Object} batch - Batch object with data and metadata
 * @param {string} apiKey - Gemini API key
 * @param {string} context - Student's research context
 * @returns {Promise<string>} Analysis result from Gemini
 */
async function processBatch(batch, apiKey, context) {
  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

  const batchPrompt = `
You are a research data analyst. Analyze this BATCH of data rows (${batch.rowStart}-${batch.rowEnd} of a larger dataset).

**Student's Research Context:**
"${context}"

**Your Task:**
1. Summarize the KEY PATTERNS in these ${batch.rowCount} rows
2. Identify any themes, frequencies, or notable findings
3. Report specific metrics or counts you observe
4. Be concise but specific - this is ONE of many batches

Format your response as:
- **Key Findings:** [Main patterns]
- **Metrics:** [Any numbers/counts]
- **Notable Items:** [Outliers or important points]

=== DATA (Rows ${batch.rowStart}-${batch.rowEnd}) ===
${batch.data}
`;

  const payload = {
    contents: [{
      parts: [{ text: batchPrompt }]
    }]
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[BATCH_API] Batch ${batch.batchNumber}: API call attempt ${attempt + 1}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000); // 45 sec per batch (vs 30)
      
      const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[BATCH_API] Batch ${batch.batchNumber}: HTTP ${response.status}`);
        lastError = `Status ${response.status}`;
        
        if (response.status === 429 && attempt < MAX_RETRIES) {
          console.warn(`[BATCH_API] Rate limited, retrying batch ${batch.batchNumber}`);
          await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
          continue;
        }
        throw new Error(lastError);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        console.error(`[BATCH_API] Batch ${batch.batchNumber}: No text in response`);
        throw new Error('No text in Gemini response');
      }

      console.log(`[BATCH_API] Batch ${batch.batchNumber}: Success (${text.length} chars)`);
      return text;

    } catch (error) {
      lastError = error.message;
      console.error(`[BATCH_API] Batch ${batch.batchNumber}: Attempt ${attempt + 1} failed - ${lastError}`);
      
      if (attempt < MAX_RETRIES) {
        const waitTime = 1500 * (attempt + 1);
        console.log(`[BATCH_API] Retrying batch ${batch.batchNumber} in ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  console.error(`[BATCH_API] Batch ${batch.batchNumber}: FAILED after ${MAX_RETRIES + 1} attempts`);
  throw new Error(`Batch ${batch.batchNumber} failed: ${lastError}`);
}

/**
 * Process all batches sequentially and collect results
 * @param {Array} batches - Array of batch objects
 * @param {string} apiKey - Gemini API key
 * @param {string} context - Student's research context
 * @returns {Promise<Array>} Array of batch analysis results
 */
async function processBatchedData(batches, apiKey, context) {
  console.log(`[BATCH] Starting processing of ${batches.length} batches`);
  
  const batchResults = [];
  const startTime = Date.now();

  for (const batch of batches) {
    // Check timeout
    if (Date.now() - startTime > BATCH_PROCESSING_TIMEOUT) {
      throw new Error(`Batch processing exceeded ${BATCH_PROCESSING_TIMEOUT}ms timeout`);
    }

    try {
      console.log(`[BATCH] Processing batch ${batch.batchNumber}/${batches.length} (rows ${batch.rowStart}-${batch.rowEnd})`);
      
      const result = await processBatch(batch, apiKey, context);
      
      batchResults.push({
        batchNumber: batch.batchNumber,
        rowStart: batch.rowStart,
        rowEnd: batch.rowEnd,
        analysis: result
      });

      console.log(`[BATCH] ✅ Batch ${batch.batchNumber} complete`);
      
      // Small delay between batches to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.error(`[BATCH] ❌ Batch ${batch.batchNumber} failed: ${error.message}`);
      throw error;
    }
  }

  console.log(`[BATCH] ✅ All ${batches.length} batches processed successfully`);
  return batchResults;
}

/**
 * Synthesize all batch results into a cohesive summary
 * @param {Array} batchResults - Array of batch analysis results
 * @param {string} apiKey - Gemini API key
 * @param {string} context - Student's research context
 * @returns {Promise<string>} Final synthesized summary
 */
async function synthesizeBatchResults(batchResults, apiKey, context) {
  console.log(`[SYNTHESIS] Synthesizing ${batchResults.length} batch results`);
  
  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

  const totalRows = batchResults.reduce((sum, b) => sum + (b.rowEnd - b.rowStart + 1), 0);

  // Compile batch summaries
  const batchSummaries = batchResults
    .map(br => `**Batch ${br.batchNumber} (Rows ${br.rowStart}-${br.rowEnd}):**\n${br.analysis}`)
    .join('\n\n');

  const synthesisPrompt = `
You are a research synthesis expert. You have received ${batchResults.length} batch analyses of a larger dataset (total ${totalRows} rows).

**Student's Research Context:**
"${context}"

**Your Task:**
Synthesize all these batch analyses into ONE cohesive overall summary. Your goal is to:

1. **Identify overarching patterns** - What themes appear across ALL batches?
2. **Aggregate metrics** - Combine counts/percentages from all batches into totals
3. **Highlight key findings** - What's the main story these ${totalRows} rows tell?
4. **Note variations** - Did any batches differ significantly from others?

**Important:** Think holistically. Don't just list all batches - synthesize them into a coherent narrative.

=== BATCH ANALYSES ===
${batchSummaries}

=== SYNTHESIS ===
Provide a single, unified summary of all ${totalRows} rows analyzed across ${batchResults.length} batches:
`;

  const payload = {
    contents: [{
      parts: [{ text: synthesisPrompt }]
    }]
  };

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[SYNTHESIS] API error: ${response.status} - ${errorText}`);
    throw new Error(`Synthesis API error: ${response.status}`);
  }

  const data = await response.json();
  const synthesisText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!synthesisText) {
    throw new Error('No text in synthesis response');
  }

  console.log(`[SYNTHESIS] ✅ Synthesis complete`);
  return synthesisText;
}

// === MAIN HANDLER ===

exports.handler = async function (event, context) {
  context.callbackWaitsForEmptyEventLoop = false;
  
  const timestamp = new Date().toISOString();
  const rateLimitKey = getRateLimitKey(event);

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
    return jsonResponse(200, { message: 'OK' }, corsHeaders);
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed. Only POST requests are accepted.' }, corsHeaders);
  }

  // === RATE LIMITING ===
  if (!checkRateLimit(rateLimitKey, 10, 60000)) {
    return jsonResponse(429, { error: 'Too many requests. Please wait before trying again.' }, corsHeaders);
  }

  // === REQUEST SIZE CHECK ===
  const contentLength = parseInt(event.headers['content-length'], 10);
  if (contentLength > 1024 * 1024) {
    return jsonResponse(413, { error: 'Request payload too large. Maximum 1MB.' }, corsHeaders);
  }

  // === API KEY CHECK ===
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    console.error(`[${timestamp}] CRITICAL: GEMINI_API_KEY not configured`);
    return jsonResponse(500, { 
      error: 'Server configuration error. Please check Netlify environment variables.' 
    }, corsHeaders);
  }

  // === REQUEST PROCESSING ===
  try {
    // Parse payload
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (parseError) {
      console.error(`[${timestamp}] JSON parse error: ${parseError.message}`);
      return jsonResponse(400, { error: 'Invalid JSON in request body' }, corsHeaders);
    }

    // Validate payload
    const validation = validatePayload(payload);
    if (!validation.valid) {
      console.warn(`[${timestamp}] Validation failed: ${validation.error}`);
      return jsonResponse(400, { error: validation.error }, corsHeaders);
    }

    // Extract data from payload
    const csvText = payload.contents?.[0]?.parts?.[0]?.text || '';
    const context = payload.context || 'No context provided';

    if (!csvText) {
      return jsonResponse(400, { error: 'No CSV data provided in request' }, corsHeaders);
    }

    console.log(`[${timestamp}] CSV data received. Length: ${csvText.length} chars`);
    console.log(`[${timestamp}] CSV first 300 chars:\n${csvText.substring(0, 300)}`);

    // === CREATE BATCHES ===
    const batches = createBatches(csvText);
    
    if (batches.length === 0) {
      console.error(`[${timestamp}] No batches created. CSV parsing failed.`);
      return jsonResponse(400, { error: 'No valid data rows found in CSV. Check CSV format.' }, corsHeaders);
    }

    console.log(`[${timestamp}] ✅ Created ${batches.length} batches`);
    batches.forEach(b => console.log(`[${timestamp}] - Batch ${b.batchNumber}: rows ${b.rowStart}-${b.rowEnd} (${b.rowCount} rows)`));

    // === PROCESS BATCHES ===
    const batchResults = await processBatchedData(batches, GEMINI_API_KEY, context);

    // === SYNTHESIZE RESULTS ===
    const finalSynthesis = await synthesizeBatchResults(batchResults, GEMINI_API_KEY, context);

    console.log(`[${timestamp}] ✅ Batch processing complete. Returning synthesis.`);

    return jsonResponse(200, {
      success: true,
      batchCount: batches.length,
      totalRowsProcessed: batches.reduce((sum, b) => sum + b.rowCount, 0),
      synthesis: finalSynthesis,
      batchSummary: batchResults.map(br => ({
        batchNumber: br.batchNumber,
        rows: `${br.rowStart}-${br.rowEnd}`,
        preview: br.analysis.substring(0, 100) + '...'
      }))
    }, corsHeaders);

  } catch (error) {
    console.error(`[${timestamp}] Error: ${error.message}`);
    console.error(`[${timestamp}] Stack: ${error.stack}`);

    if (error.message.includes('timeout')) {
      return jsonResponse(504, { error: 'Processing timeout. Dataset may be too large.' }, corsHeaders);
    }

    return jsonResponse(500, { 
      error: error.message || 'An unexpected error occurred' 
    }, corsHeaders);
  }
};
