import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: ['*'], // Configure as needed
  allowHeaders: ['Content-Type', 'x-auth-token'],
  allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
}));

// Rate limiting middleware (simple implementation)
const rateLimitMap = new Map();

const rateLimit = async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  const key = `${ip}:${Math.floor(Date.now() / (15 * 60 * 1000))}`; // 15 minute windows
  
  const count = rateLimitMap.get(key) || 0;
  if (count >= 100) {
    return c.json({ error: 'Too many requests from this IP, please try again later.' }, 429);
  }
  
  rateLimitMap.set(key, count + 1);
  
  // Clean up old entries
  if (rateLimitMap.size > 1000) {
    const currentWindow = Math.floor(Date.now() / (15 * 60 * 1000));
    for (const [k, v] of rateLimitMap.entries()) {
      const [, window] = k.split(':');
      if (parseInt(window) < currentWindow - 1) {
        rateLimitMap.delete(k);
      }
    }
  }
  
  await next();
};

app.use('*', rateLimit);

// Database operations helper
const getDbOps = (db) => ({
  // Webform structure operations
  async saveWebformStructure(webformId, structureData) {
    const result = await db.prepare(`
      INSERT OR REPLACE INTO webform_structures (webform_id, structure_data, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).bind(webformId, JSON.stringify(structureData)).run();
    return result.meta?.last_row_id;
  },

  async getWebformStructure(webformId) {
    const result = await db.prepare(`
      SELECT structure_data, created_at, updated_at 
      FROM webform_structures 
      WHERE webform_id = ? AND is_active = TRUE
    `).bind(webformId).first();
    return result;
  },

  // Submission operations
  async createSubmission(submissionId, formId, submissionData, userAgent = null, ipAddress = null) {
    const result = await db.prepare(`
      INSERT INTO submissions (submission_id, form_id, submission_data, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `).bind(submissionId, formId, JSON.stringify(submissionData), userAgent, ipAddress).run();
    return result.meta?.last_row_id;
  },

  async getSubmissionsByStatus(status, limit = 100) {
    const result = await db.prepare(`
      SELECT * FROM submissions 
      WHERE status = ? 
      ORDER BY created_at ASC 
      LIMIT ?
    `).bind(status, limit).all();
    return result.map(row => ({
      ...row,
      submission_data: JSON.parse(row.submission_data)
    }));
  },

  async updateSubmissionStatus(id, status, errorMessage = null, sentAt = null) {
    await db.prepare(`
      UPDATE submissions 
      SET status = ?, error_message = ?, sent_at = ?, 
          retry_count = CASE WHEN ? = 'failed' THEN retry_count + 1 ELSE retry_count END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(status, errorMessage, sentAt, status, id).run();
  },

  async getSubmissionStats() {
    const result = await db.prepare(`
      SELECT status, COUNT(*) as count
      FROM submissions
      GROUP BY status
    `).all();
    return result;
  },

  // Logging operations
  async logError(level, message, errorDetails = null, endpoint = null, method = null, userAgent = null, ipAddress = null) {
    await db.prepare(`
      INSERT INTO error_logs (level, message, error_details, endpoint, method, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(level, message, errorDetails, endpoint, method, userAgent, ipAddress).run();
  },

  async getRecentErrors(limit = 50) {
    const result = await db.prepare(`
      SELECT * FROM error_logs 
      ORDER BY created_at DESC 
      LIMIT ?
    `).bind(limit).all();
    return result;
  },

  // Settings operations
  async setSetting(key, value, description = null, dataType = 'string') {
    await db.prepare(`
      INSERT OR REPLACE INTO app_settings (key, value, description, data_type, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(key, value, description, dataType).run();
  },

  async getSetting(key) {
    const result = await db.prepare(`
      SELECT value, data_type FROM app_settings WHERE key = ?
    `).bind(key).first();
    if (!result) return null;
    
    const { value, data_type } = result;
    switch (data_type) {
      case 'number': return Number(value);
      case 'boolean': return value === 'true';
      case 'json': return JSON.parse(value);
      default: return value;
    }
  },

  async getAllSettings() {
    const result = await db.prepare(`
      SELECT key, value, description, data_type FROM app_settings ORDER BY key
    `).all();
    return result.map(row => ({
      ...row,
      value: row.data_type === 'json' ? JSON.parse(row.value) : row.value
    }));
  },

  // API usage tracking
  async logApiUsage(endpoint, method, statusCode, responseTimeMs, userAgent, ipAddress) {
    await db.prepare(`
      INSERT INTO api_usage (endpoint, method, status_code, response_time_ms, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(endpoint, method, statusCode, responseTimeMs, userAgent, ipAddress).run();
  },

  async getApiStats(hours = 24) {
    const result = await db.prepare(`
      SELECT endpoint, method, COUNT(*) as requests, 
             AVG(response_time_ms) as avg_response_time,
             AVG(CASE WHEN status_code >= 400 THEN 1.0 ELSE 0.0 END) * 100 as error_rate
      FROM api_usage 
      WHERE created_at >= datetime('now', '-${hours} hours')
      GROUP BY endpoint, method
      ORDER BY requests DESC
    `).all();
    return result;
  },

  async getFilteredSubmissions(filters = {}) {
    const { limit = 100, status = null, form_id = null, start_date = null, end_date = null } = filters;
    
    let query = 'SELECT * FROM submissions WHERE 1=1';
    const bindings = [];
    
    if (status) {
      query += ' AND status = ?';
      bindings.push(status);
    }
    
    if (form_id) {
      query += ' AND form_id = ?';
      bindings.push(form_id);
    }
    
    if (start_date) {
      query += ' AND created_at >= ?';
      bindings.push(start_date);
    }
    
    if (end_date) {
      query += ' AND created_at <= ?';
      bindings.push(end_date);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    bindings.push(parseInt(limit));
    
    const stmt = db.prepare(query);
    const result = await stmt.bind(...bindings).all();
    
    return result.map(row => ({
      id: row.id,
      submission_id: row.submission_id,
      form_id: row.form_id,
      data: JSON.parse(row.submission_data),
      status: row.status,
      retry_count: row.retry_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
      sent_at: row.sent_at,
      error_message: row.error_message
    }));
  }
});

// Error logging helper
const logError = async (db, level, message, error = null, req = null) => {
  try {
    const dbOps = getDbOps(db);
    await dbOps.logError(
      level,
      message,
      error ? JSON.stringify({
        message: error.message,
        stack: error.stack,
        name: error.name
      }) : null,
      req ? req.url : null,
      req ? req.method : null,
      req ? req.header('User-Agent') : null,
      req ? (req.header('CF-Connecting-IP') || req.header('X-Forwarded-For')) : null
    );
  } catch (dbError) {
    console.error('Failed to log error to database:', dbError);
  }
  console.error(`[${level.toUpperCase()}] ${message}`, error || '');
};

// Authentication middleware
const authenticateWebhook = async (c, next) => {
  const webhookSecret = c.env?.WEBHOOK_SECRET;
  if (!webhookSecret) {
    return await next();
  }
  
  const authToken = c.req.header('x-auth-token');
  
  if (!authToken || authToken !== webhookSecret) {
    await logError(c.env.DB, 'warn', 'Webhook authentication failed', null, c.req);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  await next();
};

const authenticateSubmission = async (c, next) => {
  const submissionSecret = c.env?.SUBMISSION_SECRET;
  if (!submissionSecret) {
    return await next();
  }
  
  const authToken = c.req.header('x-auth-token');
  
  if (!authToken || authToken !== submissionSecret) {
    await logError(c.env.DB, 'warn', 'Submission authentication failed', null, c.req);
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  await next();
};

// Request logging middleware
app.use('*', async (c, next) => {
  const startTime = Date.now();
  
  await next();
  
  const responseTime = Date.now() - startTime;
  try {
    const dbOps = getDbOps(c.env.DB);
    await dbOps.logApiUsage(
      c.req.url,
      c.req.method,
      c.res.status,
      responseTime,
      c.req.header('User-Agent'),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')
    );
  } catch (error) {
    console.error('Failed to log API usage:', error);
  }
});

// Routes

// Webform structure endpoints (Webhook route for backward compatibility)
app.post('/api/webhook', authenticateWebhook, async (c) => {
  try {
    const { form_id, submission_data } = await c.req.json();
    
    if (!form_id || !submission_data) {
      return c.json({ error: 'Missing form_id or submission_data' }, 400);
    }
    
    const dbOps = getDbOps(c.env.DB);
    const id = await dbOps.saveWebformStructure(form_id, submission_data);
    
    return c.json({ 
      success: true, 
      message: 'Webform structure received and saved',
      form_id,
      id
    });
  } catch (error) { 
    await logError(c.env.DB, 'error', 'Webform structure update error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Webform structure endpoints
app.post('/api/webform/:webform_id/structure', authenticateWebhook, async (c) => {
  try {
    const webform_id = c.req.param('webform_id');
    const form_data = await c.req.json();
    
    if (!webform_id) {
      return c.json({ error: 'Missing webform_id parameter' }, 400);
    }
    
    if (!form_data || Object.keys(form_data).length === 0) {
      return c.json({ error: 'Missing form structure data' }, 400);
    }
    
    const dbOps = getDbOps(c.env.DB);
    const id = await dbOps.saveWebformStructure(webform_id, form_data);
    
    return c.json({ 
      success: true, 
      message: 'Webform structure received and saved',
      webform_id,
      id
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Webform structure update error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/webform/:webform_id/structure', async (c) => {
  try {
    const webform_id = c.req.param('webform_id');
    
    const dbOps = getDbOps(c.env.DB);
    const formData = await dbOps.getWebformStructure(webform_id);
    
    if (!formData) {
      return c.json({ 
        error: 'Webform structure not found',
        webform_id 
      }, 404);
    }
    
    return c.json({
      webform_id,
      structure: JSON.parse(formData.structure_data),
      created_at: formData.created_at,
      updated_at: formData.updated_at
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Webform structure retrieval error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Submission endpoints
app.post('/api/webform/:webform_id/submission', authenticateSubmission, async (c) => {
  try {
    const form_id = c.req.param('webform_id');
    const { submission_data } = await c.req.json();
    
    if (!form_id || !submission_data) {
      return c.json({ error: 'Missing form_id or submission_data' }, 400);
    }
    
    const submissionId = `${form_id}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const submissionWithTimestamp = {
      ...submission_data,
      timestamp: new Date().toISOString(),
      submission_id: submissionId
    };
    
    const dbOps = getDbOps(c.env.DB);
    const dbId = await dbOps.createSubmission(
      submissionId,
      form_id,
      submissionWithTimestamp,
      c.req.header('User-Agent'),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')
    );
    
    return c.json({ 
      success: true, 
      message: 'Submission received and saved',
      submission_id: submissionId,
      db_id: dbId
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Submission error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/webform/submissions', authenticateSubmission, async (c) => {
  try {
    const filters = await c.req.json();
    const dbOps = getDbOps(c.env.DB);
    const submissions = await dbOps.getFilteredSubmissions(filters);
    
    return c.json({
      submissions,
      count: submissions.length,
      filters
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Submissions retrieval error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/submissions/pending', authenticateWebhook, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit')) || 100;
    const dbOps = getDbOps(c.env.DB);
    const submissions = await dbOps.getSubmissionsByStatus('pending', limit);
    
    return c.json({ 
      submissions: submissions.map(s => ({
        id: s.id,
        submission_id: s.submission_id,
        form_id: s.form_id,
        data: s.submission_data,
        created_at: s.created_at,
        retry_count: s.retry_count
      })),
      count: submissions.length
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Pending submissions error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Mark submission as sent/processed
app.patch('/api/submissions/:id/status', authenticateWebhook, async (c) => {
  try {
    const id = c.req.param('id');
    const { status, error_message } = await c.req.json();
    
    if (!['sent', 'failed', 'processing'].includes(status)) {
      return c.json({ error: 'Invalid status. Must be: sent, failed, or processing' }, 400);
    }
    
    const sentAt = status === 'sent' ? new Date().toISOString() : null;
    const dbOps = getDbOps(c.env.DB);
    await dbOps.updateSubmissionStatus(parseInt(id), status, error_message, sentAt);
    
    return c.json({ 
      success: true, 
      message: `Submission marked as ${status}`,
      id: parseInt(id)
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Submission status update error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Settings endpoints
app.get('/api/settings', authenticateWebhook, async (c) => {
  try {
    const dbOps = getDbOps(c.env.DB);
    const settings = await dbOps.getAllSettings();
    return c.json({ settings });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Settings retrieval error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/settings', authenticateWebhook, async (c) => {
  try {
    const { key, value, description, data_type = 'string' } = await c.req.json();
    
    if (!key || value === undefined) {
      return c.json({ error: 'Missing key or value' }, 400);
    }
    
    const dbOps = getDbOps(c.env.DB);
    await dbOps.setSetting(key, value, description, data_type);
    
    return c.json({ 
      success: true, 
      message: 'Setting saved',
      key,
      value
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Settings update error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Analytics endpoints
app.get('/api/analytics/submissions', authenticateWebhook, async (c) => {
  try {
    const dbOps = getDbOps(c.env.DB);
    const stats = await dbOps.getSubmissionStats();
    return c.json({ stats });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Submission analytics error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/analytics/api-usage', authenticateWebhook, async (c) => {
  try {
    const hours = parseInt(c.req.query('hours')) || 24;
    const dbOps = getDbOps(c.env.DB);
    const stats = await dbOps.getApiStats(hours);
    return c.json({ stats, hours });
  } catch (error) {
    await logError(c.env.DB, 'error', 'API usage analytics error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Error logs endpoint
app.get('/api/logs/errors', authenticateWebhook, async (c) => {
  try {
    const limit = parseInt(c.req.query('limit')) || 50;
    const dbOps = getDbOps(c.env.DB);
    const errors = await dbOps.getRecentErrors(limit);
    return c.json({ errors, limit });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Error logs retrieval error', error, c.req);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Health check endpoint
app.get('/health', async (c) => {
  try {
    const dbOps = getDbOps(c.env.DB);
    await dbOps.getSetting('health_check') || 'ok';
    
    return c.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      version: '2.0.0'
    });
  } catch (error) {
    await logError(c.env.DB, 'error', 'Health check failed', error, c.req);
    return c.json({ 
      status: 'unhealthy', 
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    }, 503);
  }
});

// 404 handler
app.notFound(async (c) => {
  await logError(c.env.DB, 'info', `404 - Route not found: ${c.req.url}`, null, c.req);
  return c.json({ error: 'Endpoint not found' }, 404);
});

// Global error handler
app.onError(async (error, c) => {
  await logError(c.env.DB, 'error', 'Unhandled error', error, c.req);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;