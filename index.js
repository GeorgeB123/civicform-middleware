import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import Joi from 'joi';
import { initializeDatabase, dbOps, closeDatabase } from './database.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Environment validation
const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  TURSO_DATABASE_URL: Joi.string().optional(),
  TURSO_AUTH_TOKEN: Joi.string().optional(),
  WEBHOOK_SECRET: Joi.string().optional(),
  SUBMISSION_SECRET: Joi.string().optional(),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development')
});

const { error, value: env } = envSchema.validate(process.env, { allowUnknown: true });

if (error) {
  console.error('Environment validation error:', error.details[0].message);
  process.exit(1);
}

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(limiter);
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 
    process.env.ALLOWED_ORIGINS?.split(',') : 
    true,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use(async (req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', async () => {
    const responseTime = Date.now() - startTime;
    try {
      await dbOps.logApiUsage(
        req.originalUrl,
        req.method,
        res.statusCode,
        responseTime,
        req.get('User-Agent'),
        req.ip || req.connection?.remoteAddress
      );
    } catch (error) {
      console.error('Failed to log API usage:', error);
    }
  });
  
  next();
});

// Error logging helper
const logError = async (level, message, error = null, req = null) => {
  try {
    await dbOps.logError(
      level,
      message,
      error ? JSON.stringify({
        message: error.message,
        stack: error.stack,
        name: error.name
      }) : null,
      req ? req.originalUrl : null,
      req ? req.method : null,
      req ? req.get('User-Agent') : null,
      req ? (req.ip || req.connection?.remoteAddress) : null
    );
  } catch (dbError) {
    console.error('Failed to log error to database:', dbError);
  }
  console.error(`[${level.toUpperCase()}] ${message}`, error || '');
};

// Authentication middleware
const authenticateWebhook = async (req, res, next) => {
  if (!env.WEBHOOK_SECRET) {
    return next();
  }
  
  const authToken = req.headers['x-auth-token'];
  
  if (!authToken || authToken !== env.WEBHOOK_SECRET) {
    await logError('warn', 'Webhook authentication failed', null, req);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

const authenticateSubmission = async (req, res, next) => {
  if (!env.SUBMISSION_SECRET) {
    return next();
  }
  
  const authToken = req.headers['x-auth-token'];
  
  if (!authToken || authToken !== env.SUBMISSION_SECRET) {
    await logError('warn', 'Submission authentication failed', null, req);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

// Routes

// Webform structure endpoints
app.post('/api/webform/:webform_id/structure', authenticateWebhook, async (req, res) => {
  try {
    const { webform_id } = req.params;
    const form_data = req.body;
    
    if (!webform_id) {
      return res.status(400).json({ error: 'Missing webform_id parameter' });
    }
    
    if (!form_data || Object.keys(form_data).length === 0) {
      return res.status(400).json({ error: 'Missing form structure data' });
    }
    
    const id = await dbOps.saveWebformStructure(webform_id, form_data);
    
    res.json({ 
      success: true, 
      message: 'Webform structure received and saved',
      webform_id,
      id
    });
  } catch (error) {
    await logError('error', 'Webform structure update error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/webform/:webform_id/structure', async (req, res) => {
  try {
    const { webform_id } = req.params;
    
    const formData = await dbOps.getWebformStructure(webform_id);
    
    if (!formData) {
      return res.status(404).json({ 
        error: 'Webform structure not found',
        webform_id 
      });
    }
    
    res.json({
      webform_id,
      structure: JSON.parse(formData.structure_data),
      created_at: formData.created_at,
      updated_at: formData.updated_at
    });
  } catch (error) {
    await logError('error', 'Webform structure retrieval error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submission endpoints
app.post('/api/webform/:webform_id/submission', authenticateSubmission, async (req, res) => {
  try {
    const { form_id } = req.params;
    const { submission_data } = req.body;
    
    if (!form_id || !submission_data) {
      return res.status(400).json({ error: 'Missing form_id or submission_data' });
    }
    
    const submissionId = `${form_id}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const submissionWithTimestamp = {
      ...submission_data,
      timestamp: new Date().toISOString(),
      submission_id: submissionId
    };
    
    const dbId = await dbOps.createSubmission(
      submissionId,
      form_id,
      submissionWithTimestamp,
      req.get('User-Agent'),
      req.ip || req.connection?.remoteAddress
    );
    
    res.json({ 
      success: true, 
      message: 'Submission received and saved',
      submission_id: submissionId,
      db_id: dbId
    });
  } catch (error) {
    await logError('error', 'Submission error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/webform/submissions', authenticateSubmission, async (req, res) => {
  try {
    const filters = req.body;
    const submissions = await dbOps.getFilteredSubmissions(filters);
    
    res.json({
      submissions,
      count: submissions.length,
      filters
    });
  } catch (error) {
    await logError('error', 'Submissions retrieval error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
})

app.get('/api/submissions/pending', authenticateWebhook, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const submissions = await dbOps.getSubmissionsByStatus('pending', limit);
    
    res.json({ 
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
    await logError('error', 'Pending submissions error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark submission as sent/processed
app.patch('/api/submissions/:id/status', authenticateWebhook, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, error_message } = req.body;
    
    if (!['sent', 'failed', 'processing'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: sent, failed, or processing' });
    }
    
    const sentAt = status === 'sent' ? new Date().toISOString() : null;
    await dbOps.updateSubmissionStatus(parseInt(id), status, error_message, sentAt);
    
    res.json({ 
      success: true, 
      message: `Submission marked as ${status}`,
      id: parseInt(id)
    });
  } catch (error) {
    await logError('error', 'Submission status update error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Settings endpoints
app.get('/api/settings', authenticateWebhook, async (req, res) => {
  try {
    const settings = await dbOps.getAllSettings();
    res.json({ settings });
  } catch (error) {
    await logError('error', 'Settings retrieval error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/settings', authenticateWebhook, async (req, res) => {
  try {
    const { key, value, description, data_type = 'string' } = req.body;
    
    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Missing key or value' });
    }
    
    await dbOps.setSetting(key, value, description, data_type);
    
    res.json({ 
      success: true, 
      message: 'Setting saved',
      key,
      value
    });
  } catch (error) {
    await logError('error', 'Settings update error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Analytics endpoints
app.get('/api/analytics/submissions', authenticateWebhook, async (req, res) => {
  try {
    const stats = await dbOps.getSubmissionStats();
    res.json({ stats });
  } catch (error) {
    await logError('error', 'Submission analytics error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/analytics/api-usage', authenticateWebhook, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const stats = await dbOps.getApiStats(hours);
    res.json({ stats, hours });
  } catch (error) {
    await logError('error', 'API usage analytics error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error logs endpoint
app.get('/api/logs/errors', authenticateWebhook, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const errors = await dbOps.getRecentErrors(limit);
    res.json({ errors, limit });
  } catch (error) {
    await logError('error', 'Error logs retrieval error', error, req);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await dbOps.getSetting('health_check') || 'ok';
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      database: 'connected',
      version: '2.0.0'
    });
  } catch (error) {
    await logError('error', 'Health check failed', error, req);
    res.status(503).json({ 
      status: 'unhealthy', 
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// 404 handler
app.use('*', async (req, res) => {
  await logError('info', `404 - Route not found: ${req.originalUrl}`, null, req);
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use(async (error, req, res, next) => {
  await logError('error', 'Unhandled error', error, req);
  res.status(500).json({ error: 'Internal server error' });
});

// Server startup
const startServer = async () => {
  try {
    await initializeDatabase();
    
    // Set some default settings if they don't exist
    const appName = await dbOps.getSetting('app_name');
    if (!appName) {
      await dbOps.setSetting('app_name', 'CivicForm Middleware', 'Application name');
      await dbOps.setSetting('max_retry_attempts', '3', 'Maximum retry attempts for failed submissions', 'number');
      await dbOps.setSetting('cleanup_logs_after_days', '30', 'Days to keep error logs', 'number');
    }
    
    app.listen(PORT, () => {
      console.log(`🚀 CivicForm Middleware listening on port ${PORT}`);
      console.log(`📊 Environment: ${env.NODE_ENV}`);
      console.log(`💾 Database: ${env.TURSO_DATABASE_URL ? 'Turso' : 'Local SQLite'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('\n🛑 Shutting down gracefully...');
  closeDatabase();
  process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

startServer();