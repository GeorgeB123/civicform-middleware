# Civicform Middleware

A Node.js middleware application that bridges a secure Drupal 11 backend with a Next.js frontend. The middleware caches form structures from Drupal in Redis and handles form submissions from the frontend.

## Overview

This middleware solves the challenge of connecting a secure Drupal backend (which cannot accept incoming requests) with a Next.js frontend by:

- **Caching form structures** from Drupal webhooks in Redis
- **Accepting form submissions** from the frontend
- **Providing cached data** via API endpoints
- **Queuing submissions** for Drupal to poll and retrieve

## Architecture

```
Drupal Backend → [Webhook] → Middleware → [API] → Next.js Frontend
                     ↓
                  Redis Cache
                     ↑
            [Polling] ← Drupal Cron Job
```

## Quick Start

### Prerequisites

- Node.js (v18 or higher)
- Redis server
- npm or yarn

### Installation

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Start Redis:**
   ```bash
   # Using Homebrew (macOS)
   brew services start redis
   
   # Or run directly
   redis-server
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

4. **Start the application:**
   ```bash
   # Production
   npm start
   
   # Development (with file watching)
   npm run dev
   ```

The server will start on `http://localhost:3000`

## API Endpoints

### 1. Webform Structure Receiver
**POST** `/api/webform/{webform_id}/structure`

Receives form structure updates from Drupal and caches them in Redis.

```bash
curl -X POST http://localhost:3000/api/webform/contact_form/structure \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Contact Us",
    "fields": [
      {"name": "email", "type": "email", "required": true},
      {"name": "message", "type": "textarea", "required": true}
    ]
  }'
```

### 2. Webform Structure API
**GET** `/api/webform/{webform_id}/structure`

Returns cached webform structure for the frontend.

```bash
curl http://localhost:3000/api/webform/contact_form/structure
```

Response:
```json
{
  "webform_id": "contact_form",
  "structure": {
    "title": "Contact Us",
    "fields": [
      {"name": "email", "type": "email", "required": true},
      {"name": "message", "type": "textarea", "required": true}
    ]
  }
}
```

### 3. Form Structure API (Legacy)
**GET** `/api/forms/:id`

Legacy endpoint that returns cached form structure for backward compatibility.

```bash
curl http://localhost:3000/api/forms/contact_form
```

Response:
```json
{
  "title": "Contact Us",
  "fields": [
    {"name": "email", "type": "email", "required": true},
    {"name": "message", "type": "textarea", "required": true}
  ]
}
```

### 4. Submission Receiver
**POST** `/api/submissions`

Accepts form submissions from the frontend.

```bash
curl -X POST http://localhost:3000/api/submissions \
  -H "Content-Type: application/json" \
  -d '{
    "form_id": "contact_form",
    "submission_data": {
      "email": "user@example.com",
      "message": "Hello, this is a test message"
    }
  }'
```

Response:
```json
{
  "success": true,
  "message": "Submission received and queued",
  "submission_id": "contact_form_1678901234567_abc123"
}
```

### 5. Submission Export
**GET** `/api/submissions/pending`

Returns and clears all pending submissions (used by Drupal cron).

```bash
curl http://localhost:3000/api/submissions/pending
```

Response:
```json
{
  "submissions": [
    {
      "form_id": "contact_form",
      "data": {
        "email": "user@example.com",
        "message": "Hello, this is a test message",
        "timestamp": "2024-01-15T10:30:00.000Z",
        "id": "contact_form_1678901234567_abc123"
      }
    }
  ]
}
```

### 6. Health Check
**GET** `/health`

Returns application health status.

```bash
curl http://localhost:3000/health
```

## Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```bash
# Server Configuration
PORT=3000
NODE_ENV=development

# Redis Configuration
REDIS_URL=redis://localhost:6379

# Authentication Secrets (optional for testing)
WEBHOOK_SECRET=your-webhook-secret-here
SUBMISSION_SECRET=your-submission-secret-here

# CORS Configuration (production only)
ALLOWED_ORIGINS=https://yourfrontend.com,https://anotherdomain.com
```

### Redis Data Structure

The middleware uses the following Redis keys:

- `webform:{form_id}` — JSON string of form structure
- `submissions:{form_id}` — Redis List of pending submission JSON objects

## Security Features

- **Helmet.js** for security headers
- **CORS** protection with configurable origins
- **Rate limiting** (100 requests per 15 minutes per IP)
- **Request size limits** (10MB max)
- **Authentication middleware** via `X-Auth-Token` header
- **Input validation** with Joi

### Authentication

When authentication is enabled (secrets provided), include the auth token in headers:

```bash
# For webhook endpoints
curl -H "X-Auth-Token: your-webhook-secret" ...

# For submission endpoints  
curl -H "X-Auth-Token: your-submission-secret" ...
```

## Testing the Application

### 1. Test Form Structure Caching

```bash
# Send webform structure (cache form structure)
curl -X POST http://localhost:3000/api/webform/test_form/structure \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Form", 
    "fields": [
      {"name": "test_field", "type": "text", "required": false}
    ]
  }'

# Retrieve cached form (new endpoint)
curl http://localhost:3000/api/webform/test_form/structure

# Or use legacy endpoint
curl http://localhost:3000/api/forms/test_form
```

### 2. Test Submission Flow

```bash
# Submit a form
curl -X POST http://localhost:3000/api/submissions \
  -H "Content-Type: application/json" \
  -d '{
    "form_id": "test_form",
    "submission_data": {"field1": "value1", "field2": "value2"}
  }'

# Check pending submissions
curl http://localhost:3000/api/submissions/pending
```

### 3. Test Health Check

```bash
curl http://localhost:3000/health
```

## Development

### Scripts

- `npm start` — Start production server
- `npm run dev` — Start development server with file watching
- `npm test` — Run tests (not implemented)

### Monitoring

The application includes:

- Console logging for errors and connections
- Health check endpoint for monitoring
- Graceful shutdown handling
- Redis connection status tracking

## Production Deployment

### Environment Setup

1. Set `NODE_ENV=production`
2. Configure strong authentication secrets
3. Set up proper CORS origins
4. Use a Redis cluster for high availability
5. Set up process monitoring (PM2, etc.)
6. Configure reverse proxy (nginx) with SSL

### Example Production Config

```bash
NODE_ENV=production
PORT=3000
REDIS_URL=redis://your-redis-cluster:6379
WEBHOOK_SECRET=strong-random-secret-1
SUBMISSION_SECRET=strong-random-secret-2
ALLOWED_ORIGINS=https://yourdomain.com
```

## Troubleshooting

### Common Issues

1. **Redis Connection Error**
   ```bash
   # Check if Redis is running
   redis-cli ping
   
   # Start Redis
   brew services start redis  # macOS
   sudo systemctl start redis # Linux
   ```

2. **Environment Validation Error**
   - Ensure all required environment variables are set
   - Check `.env` file format and values

3. **CORS Issues**
   - Verify `ALLOWED_ORIGINS` in production
   - Check frontend origin matches configuration

4. **Authentication Failures**
   - Verify `X-Auth-Token` header is included
   - Check secret values match between client and server

### Logs

The application logs important events:
- Server startup and shutdown
- Redis connection status
- API request errors
- Webhook processing

## License

ISC