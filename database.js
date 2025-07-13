import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

// Initialize database connection (Turso for production, SQLite for local)
const initializeDatabase = async () => {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    // Use Turso for production
    console.log('🌐 Connecting to Turso database...');
    db = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  } else {
    // Use local SQLite for development
    console.log('💾 Using local SQLite database...');
    const dbPath = join(__dirname, 'data');
    mkdirSync(dbPath, { recursive: true });
    
    const sqliteDb = new Database(join(dbPath, 'civicform.db'));
    sqliteDb.pragma('journal_mode = WAL');
    
    // Wrapper to make better-sqlite3 compatible with libsql client interface
    db = {
      execute: (sql, params = []) => {
        try {
          const stmt = sqliteDb.prepare(sql);
          if (sql.trim().toUpperCase().startsWith('SELECT')) {
            return { rows: stmt.all(params) };
          } else {
            const result = stmt.run(params);
            return { 
              rows: [], 
              meta: { 
                last_insert_rowid: result.lastInsertRowid,
                changes: result.changes 
              } 
            };
          }
        } catch (error) {
          throw error;
        }
      },
      close: () => sqliteDb.close()
    };
  }

  // Create all tables
  await createTables();
  console.log('📊 Database initialized successfully');
};

const createTables = async () => {
  // Webform structures table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS webform_structures (
      id INTEGER PRIMARY KEY,
      webform_id TEXT UNIQUE NOT NULL,
      structure_data TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      is_active BOOLEAN DEFAULT TRUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Submissions table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY,
      submission_id TEXT UNIQUE NOT NULL,
      form_id TEXT NOT NULL,
      submission_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME NULL,
      error_message TEXT NULL,
      user_agent TEXT NULL,
      ip_address TEXT NULL
    )
  `);

  // Error logs table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id INTEGER PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      error_details TEXT NULL,
      endpoint TEXT NULL,
      method TEXT NULL,
      user_agent TEXT NULL,
      ip_address TEXT NULL,
      session_id TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Application settings table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      data_type TEXT DEFAULT 'string',
      description TEXT NULL,
      is_encrypted BOOLEAN DEFAULT FALSE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Webhook logs table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY,
      webhook_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      response_status INTEGER NULL,
      response_body TEXT NULL,
      processing_time_ms INTEGER NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // API usage tracking table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_time_ms INTEGER NULL,
      user_agent TEXT NULL,
      ip_address TEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Rate limit tracking table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      id INTEGER PRIMARY KEY,
      ip_address TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      request_count INTEGER DEFAULT 1,
      window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for performance
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_submissions_form_id ON submissions(form_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_error_logs_level ON error_logs(level)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_error_logs_created_at ON error_logs(created_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_webhook_logs_type ON webhook_logs(webhook_type)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint ON api_usage(endpoint)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_api_usage_created_at ON api_usage(created_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON rate_limits(ip_address, endpoint)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_webform_structures_webform_id ON webform_structures(webform_id)`);
};

// Database operations
const dbOps = {
  // Webform structure operations
  async saveWebformStructure(webformId, structureData) {
    const result = await db.execute(`
      INSERT OR REPLACE INTO webform_structures (webform_id, structure_data, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `, [webformId, JSON.stringify(structureData)]);
    return result.meta?.last_insert_rowid;
  },

  async getWebformStructure(webformId) {
    const result = await db.execute(`
      SELECT structure_data, created_at, updated_at 
      FROM webform_structures 
      WHERE webform_id = ? AND is_active = TRUE
    `, [webformId]);
    return result.rows[0];
  },

  // Submission operations
  async createSubmission(submissionId, formId, submissionData, userAgent = null, ipAddress = null) {
    const result = await db.execute(`
      INSERT INTO submissions (submission_id, form_id, submission_data, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `, [submissionId, formId, JSON.stringify(submissionData), userAgent, ipAddress]);
    return result.meta?.last_insert_rowid;
  },

  async getSubmissionsByStatus(status, limit = 100) {
    const result = await db.execute(`
      SELECT * FROM submissions 
      WHERE status = ? 
      ORDER BY created_at ASC 
      LIMIT ?
    `, [status, limit]);
    return result.rows.map(row => ({
      ...row,
      submission_data: JSON.parse(row.submission_data)
    }));
  },

  async updateSubmissionStatus(id, status, errorMessage = null, sentAt = null) {
    const retryCount = status === 'failed' ? 'retry_count + 1' : 'retry_count';
    await db.execute(`
      UPDATE submissions 
      SET status = ?, error_message = ?, sent_at = ?, 
          retry_count = ${retryCount}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [status, errorMessage, sentAt, id]);
  },

  async getSubmissionStats() {
    const result = await db.execute(`
      SELECT status, COUNT(*) as count
      FROM submissions
      GROUP BY status
    `);
    return result.rows;
  },

  // Logging operations
  async logError(level, message, errorDetails = null, endpoint = null, method = null, userAgent = null, ipAddress = null) {
    await db.execute(`
      INSERT INTO error_logs (level, message, error_details, endpoint, method, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [level, message, errorDetails, endpoint, method, userAgent, ipAddress]);
  },

  async getRecentErrors(limit = 50) {
    const result = await db.execute(`
      SELECT * FROM error_logs 
      ORDER BY created_at DESC 
      LIMIT ?
    `, [limit]);
    return result.rows;
  },

  // Settings operations
  async setSetting(key, value, description = null, dataType = 'string') {
    await db.execute(`
      INSERT OR REPLACE INTO app_settings (key, value, description, data_type, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [key, value, description, dataType]);
  },

  async getSetting(key) {
    const result = await db.execute(`
      SELECT value, data_type FROM app_settings WHERE key = ?
    `, [key]);
    if (result.rows.length === 0) return null;
    
    const { value, data_type } = result.rows[0];
    switch (data_type) {
      case 'number': return Number(value);
      case 'boolean': return value === 'true';
      case 'json': return JSON.parse(value);
      default: return value;
    }
  },

  async getAllSettings() {
    const result = await db.execute(`
      SELECT key, value, description, data_type FROM app_settings ORDER BY key
    `);
    return result.rows.map(row => ({
      ...row,
      value: row.data_type === 'json' ? JSON.parse(row.value) : row.value
    }));
  },

  // API usage tracking
  async logApiUsage(endpoint, method, statusCode, responseTimeMs, userAgent, ipAddress) {
    await db.execute(`
      INSERT INTO api_usage (endpoint, method, status_code, response_time_ms, user_agent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [endpoint, method, statusCode, responseTimeMs, userAgent, ipAddress]);
  },

  async getApiStats(hours = 24) {
    const result = await db.execute(`
      SELECT endpoint, method, COUNT(*) as requests, 
             AVG(response_time_ms) as avg_response_time,
             AVG(CASE WHEN status_code >= 400 THEN 1.0 ELSE 0.0 END) * 100 as error_rate
      FROM api_usage 
      WHERE created_at >= datetime('now', '-${hours} hours')
      GROUP BY endpoint, method
      ORDER BY requests DESC
    `);
    return result.rows;
  },

  async getFilteredSubmissions(filters = {}) {
    const { limit = 100, status = null, form_id = null, start_date = null, end_date = null } = filters;
    
    let query = 'SELECT * FROM submissions WHERE 1=1';
    const params = [];
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    if (form_id) {
      query += ' AND form_id = ?';
      params.push(form_id);
    }
    
    if (start_date) {
      query += ' AND created_at >= ?';
      params.push(start_date);
    }
    
    if (end_date) {
      query += ' AND created_at <= ?';
      params.push(end_date);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    
    const result = await db.execute(query, params);
    
    return result.rows.map(row => ({
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
};

// Cleanup function
const closeDatabase = () => {
  if (db?.close) {
    db.close();
  }
};

export { initializeDatabase, dbOps, closeDatabase };