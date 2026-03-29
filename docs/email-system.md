# CueDeck Email System

Automated founder welcome emails sent to users after their first login.

## Overview

The email system consists of:

1. **Founder Welcome Email** - Sent immediately after first login
2. **Feature Deep Dive** - Sent 3 days later
3. **Social Proof & Tips** - Sent 7 days later
4. **Check-in** - Sent 14 days later

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────┐
│  User Login     │────▶│  handle_first_login  │────▶│  welcome_   │
│  (Frontend)     │     │  (SQL Function)      │     │  email_     │
└─────────────────┘     └──────────────────────┘     │  trigger    │
                                                      └──────┬──────┘
                                                             │
                        ┌──────────────────────┐             │
                        │  process-welcome-    │◀────────────┘
                        │  triggers (Cron)     │
                        └──────────┬───────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐     ┌─────────────┐
                        │  send-welcome-email  │────▶│   Resend    │
                        │  (Edge Function)     │     │    API      │
                        └──────────┬───────────┘     └─────────────┘
                                   │
                                   ▼
                        ┌──────────────────────┐
                        │   email_queue        │  (Day 3, 7, 14 emails)
                        └──────────┬───────────┘
                                   │
                        ┌──────────────────────┐
                        │  process-email-queue │◀───── Hourly Cron
                        │  (Edge Function)     │
                        └──────────────────────┘
```

## Setup Instructions

### 1. Get Resend API Key

1. Sign up at [Resend](https://resend.com)
2. Verify your domain (cuedeck.io)
3. Create an API key
4. Copy the key (starts with `re_`)

### 2. Set Supabase Secrets

```bash
# Navigate to project
cd "/Users/sheriff/Downloads/AVE Production Console"

# Set Resend API key
supabase secrets set RESEND_API_KEY=re_your_api_key_here

# Set sender info
supabase secrets set FROM_EMAIL=sheriff@cuedeck.io
supabase secrets set FROM_NAME="Sheriff from CueDeck"

# Set allowed origin for CORS
supabase secrets set ALLOWED_ORIGIN=https://app.cuedeck.io
```

### 3. Run Database Migration

In Supabase Dashboard → SQL Editor, run:

```sql
-- Copy contents of: supabase/migrations/20260329_email_system.sql
```

Or via CLI:
```bash
supabase db push
```

### 4. Deploy Edge Functions

```bash
# Deploy all email functions
supabase functions deploy send-welcome-email
supabase functions deploy process-welcome-triggers
supabase functions deploy process-email-queue
```

### 5. Set Up Cron Jobs

In Supabase Dashboard → Database → Extensions → Enable `pg_cron`

Then run:

```sql
-- Process welcome triggers every 5 minutes
SELECT cron.schedule(
  'process-welcome-triggers',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://your-project-ref.supabase.co/functions/v1/process-welcome-triggers',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  )
  $$
);

-- Process email queue every hour
SELECT cron.schedule(
  'process-email-queue',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://your-project-ref.supabase.co/functions/v1/process-email-queue',
    headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
  )
  $$
);
```

### 6. Integrate with Frontend

After successful login, call the `handle_first_login` function:

```javascript
// In cuedeck-console.html after auth success
const { data, error } = await supabase.rpc('handle_first_login', {
  p_user_id: user.id
});

if (data?.welcome_email_queued) {
  console.log('Welcome email queued for new user');
}
```

## Email Templates

Templates are in `supabase/functions/_shared/email-templates.ts`:

- `founderWelcomeEmail(user)` - Immediate welcome
- `featureDeepDiveEmail(user)` - Day 3 features
- `socialProofEmail(user)` - Day 7 social proof
- `checkInEmail(user)` - Day 14 check-in

### Customizing Templates

Edit the template functions in `email-templates.ts`. Each returns:

```typescript
{
  subject: string,
  html: string,    // Full HTML email
  text: string     // Plain text fallback
}
```

Brand settings (founder name, colors, etc.) are in the `BRAND` object.

## Database Tables

### email_log
Tracks all sent emails for analytics and preventing duplicates.

| Column | Type | Description |
|--------|------|-------------|
| user_id | UUID | User who received email |
| email_type | TEXT | Template ID |
| resend_id | TEXT | Resend tracking ID |
| sent_at | TIMESTAMPTZ | When sent |
| opened_at | TIMESTAMPTZ | When opened (webhook) |
| clicked_at | TIMESTAMPTZ | When clicked (webhook) |

### email_queue
Scheduled emails pending delivery.

| Column | Type | Description |
|--------|------|-------------|
| user_id | UUID | Target user |
| email_type | TEXT | Template ID |
| scheduled_for | TIMESTAMPTZ | When to send |
| status | TEXT | pending/sent/failed/skipped |

### welcome_email_trigger
Queue for first-login welcome emails.

| Column | Type | Description |
|--------|------|-------------|
| user_id | UUID | New user |
| email | TEXT | Email address |
| processed | BOOLEAN | Has been sent |

## Monitoring

### Check Email Logs

```sql
-- Recent emails sent
SELECT * FROM email_log ORDER BY sent_at DESC LIMIT 20;

-- Emails by type
SELECT email_type, COUNT(*) FROM email_log GROUP BY email_type;
```

### Check Queue Status

```sql
-- Pending emails
SELECT * FROM email_queue WHERE status = 'pending' ORDER BY scheduled_for;

-- Failed emails
SELECT * FROM email_queue WHERE status = 'failed';
```

### Check Unprocessed Triggers

```sql
SELECT * FROM welcome_email_trigger WHERE processed = false;
```

## Troubleshooting

### Emails not sending

1. Check Resend API key is set: `supabase secrets list`
2. Check Edge Function logs: `supabase functions logs send-welcome-email`
3. Verify domain is verified in Resend dashboard

### Duplicate emails

The system prevents duplicates via:
- `email_log` table checks before sending
- `welcome_email_sent` flag on `leod_users`
- `ON CONFLICT DO NOTHING` on trigger inserts

### Test sending

```bash
# Test welcome email function
curl -X POST "https://your-project-ref.supabase.co/functions/v1/send-welcome-email" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "test-uuid", "email": "test@example.com", "name": "Test User"}'
```
