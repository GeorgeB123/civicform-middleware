import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { createClient } from 'redis';
import Joi from 'joi';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redis.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

const envSchema = Joi.object({
  PORT: Joi.number().default(3000),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  WEBHOOK_SECRET: Joi.string().optional(),
  SUBMISSION_SECRET: Joi.string().optional(),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development')
});

const { error, value: env } = envSchema.validate(process.env, { allowUnknown: true });

if (error) {
  console.error('Environment validation error:', error.details[0].message);
  process.exit(1);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

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

const authenticateWebhook = (req, res, next) => {
  if (!env.WEBHOOK_SECRET) {
    return next();
  }
  
  const authToken = req.headers['x-auth-token'];
  
  if (!authToken || authToken !== env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

const authenticateSubmission = (req, res, next) => {
  if (!env.SUBMISSION_SECRET) {
    return next();
  }
  
  const authToken = req.headers['x-auth-token'];
  
  if (!authToken || authToken !== env.SUBMISSION_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
};

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
    
    const key = `webform:${webform_id}`;
    await redis.set(key, JSON.stringify(form_data));
    
    res.json({ 
      success: true, 
      message: 'Webform structure received and cached',
      webform_id 
    });
  } catch (error) {
    console.error('Webform structure update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/webform/:webform_id/structure', async (req, res) => {
  try {
    const { webform_id } = req.params;
    const key = `webform:${webform_id}`;
    
    const formData = await redis.get(key);
    
    if (!formData) {
      return res.status(404).json({ 
        error: 'Webform structure not found',
        webform_id 
      });
    }
    
    res.json({
      webform_id,
      structure: JSON.parse(formData)
    });
  } catch (error) {
    console.error('Webform structure retrieval error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/submissions', authenticateSubmission, async (req, res) => {
  try {
    const { form_id, submission_data } = req.body;
    
    if (!form_id || !submission_data) {
      return res.status(400).json({ error: 'Missing form_id or submission_data' });
    }
    
    const key = `submissions:${form_id}`;
    const submissionWithTimestamp = {
      ...submission_data,
      timestamp: new Date().toISOString(),
      id: `${form_id}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    };
    
    await redis.rPush(key, JSON.stringify(submissionWithTimestamp));
    
    res.json({ 
      success: true, 
      message: 'Submission received and queued',
      submission_id: submissionWithTimestamp.id 
    });
  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/submissions/pending', authenticateWebhook, async (req, res) => {
  try {
    const pattern = 'submissions:*';
    const keys = await redis.keys(pattern);
    
    if (keys.length === 0) {
      return res.json({ submissions: [] });
    }
    
    const allSubmissions = [];
    
    for (const key of keys) {
      const submissions = await redis.lRange(key, 0, -1);
      const formId = key.replace('submissions:', '');
      
      for (const submission of submissions) {
        allSubmissions.push({
          form_id: formId,
          data: JSON.parse(submission)
        });
      }
      
      await redis.del(key);
    }
    
    res.json({ submissions: allSubmissions });
  } catch (error) {
    console.error('Pending submissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    redis: redis.isReady ? 'connected' : 'disconnected'
  });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

const startServer = async () => {
  try {
    await redis.connect();
    
    app.listen(PORT, () => {
      console.log(`🚀 Civicform Middleware listening on port ${PORT}`);
      console.log(`📊 Environment: ${env.NODE_ENV}`);
      console.log(`🔌 Redis: ${redis.isReady ? 'Connected' : 'Disconnected'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await redis.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await redis.disconnect();
  process.exit(0);
});

startServer();