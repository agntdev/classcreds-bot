# Student Credential Distributor — Bot specification

**Archetype:** workflow

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

Telegram bot that securely processes CSV files containing student identifiers and passwords, matches them to Telegram users via username/email, and sends private 1:1 messages with credentials. Provides uploaders with delivery reports including success/failure counts and failure details.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- teachers
- school administrators

## Success criteria

- 100% accurate CSV parsing and user matching
- 99%+ message delivery rate with retry logic
- Automated failure reporting with actionable CSV exports

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open admin dashboard with upload/status options
- **/upload** (command, actor: user, command: /upload) — Initiate CSV upload workflow
- **/status** (command, actor: user, command: /status) — View last job summary and delivery statistics
- **View failure details** (button, actor: user, callback: report:failures) — Request CSV of failed deliveries from last job
  - inputs: job_id
  - outputs: failure_csv

## Flows

### csv_upload_flow
_Trigger:_ /upload

1. Request CSV file upload
2. Validate CSV format (2 columns, header row)
3. Parse student records
4. Match identifiers to Telegram users
5. Queue personalized messages
6. Execute delivery with rate limiting
7. Generate delivery summary
8. Send failure CSV if any

_Data touched:_ upload_job, student_record

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **upload_job** _(retention: persistent)_ — CSV import operation metadata
  - fields: uploader_id, timestamp, total_records, success_count, failure_count
- **student_record** _(retention: persistent)_ — Parsed student credential data
  - fields: identifier, password, telegram_user_id, delivery_status, failure_reason

## Integrations

- **Telegram** (required) — Bot API messaging and user matching
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure admin user whitelist
- Set delivery retry policy
- Adjust retention period (default 30 days)
- Enable/disable email-based user matching

## Notifications

- Delivery summary DM to uploader
- Failure CSV attachment on request
- Real-time delivery status updates during processing

## Permissions & privacy

- Restrict CSV upload to whitelisted admin users
- Encrypt sensitive fields in memory
- Purge all data after 30 days
- Never store plaintext passwords

## Edge cases

- CSV with missing header row
- Unmatched identifiers (no Telegram user found)
- Telegram user with both username and email match
- Rate limit throttling during delivery

## Required tests

- End-to-end CSV upload → delivery → reporting workflow
- Validation of 30-day data purging
- Retry logic for transient delivery failures
- Whitelist enforcement for admin commands

## Assumptions

- Telegram users have either public usernames or linked emails
- Admins will handle password security upstream
- Schools will maintain their own audit logs separately
