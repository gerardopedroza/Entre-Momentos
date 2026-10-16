PRAGMA foreign_keys = ON;

CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
  drive_root_folder_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  event_date TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'inactive', 'finished')),
  cover_asset_id TEXT,
  drive_folder_url TEXT,
  drive_folder_id TEXT,
  dedications_sheet_url TEXT,
  dedications_sheet_id TEXT,
  drive_status TEXT NOT NULL DEFAULT 'not_configured' CHECK (drive_status IN ('not_configured', 'pending', 'ready', 'error')),
  contests_enabled INTEGER NOT NULL DEFAULT 1 CHECK (contests_enabled IN (0, 1)),
  public_staff_slug TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX events_by_venue_day ON events(venue_id, event_date);
CREATE INDEX events_active_by_venue ON events(venue_id, state, event_date);
CREATE UNIQUE INDEX one_active_event_per_venue_day ON events(venue_id, event_date) WHERE state = 'active';
CREATE UNIQUE INDEX event_drive_folder_once ON events(drive_folder_id) WHERE drive_folder_id IS NOT NULL;

CREATE TRIGGER active_event_requires_active_venue_insert
BEFORE INSERT ON events WHEN NEW.state='active' AND (SELECT active FROM venues WHERE id=NEW.venue_id) != 1
BEGIN SELECT RAISE(ABORT, 'venue_inactive'); END;
CREATE TRIGGER active_event_requires_active_venue_update
BEFORE UPDATE OF state,venue_id ON events WHEN NEW.state='active' AND (SELECT active FROM venues WHERE id=NEW.venue_id) != 1
BEGIN SELECT RAISE(ABORT, 'venue_inactive'); END;

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('event_cover', 'activity_reference')),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  created_at TEXT NOT NULL
);

CREATE TABLE event_activities (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  photo_opens_at TEXT NOT NULL,
  photo_closes_at TEXT NOT NULL,
  reference_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  drive_folder_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at < ends_at),
  CHECK (photo_opens_at <= photo_closes_at)
);
CREATE INDEX activities_by_event_time ON event_activities(event_id, active, starts_at);
CREATE UNIQUE INDEX activities_by_event_position ON event_activities(event_id, position) WHERE active = 1;

CREATE TABLE event_tables (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE(event_id, name)
);

CREATE TABLE event_guests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  invitation_code_hash TEXT NOT NULL,
  table_id TEXT REFERENCES event_tables(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(event_id, invitation_code_hash)
);
CREATE INDEX guests_by_event_name ON event_guests(event_id, name_key, active);

CREATE TABLE guest_sessions (
  id_hash TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES event_guests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  id_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE admin_login_attempts (
  ip_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE photo_submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES event_activities(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES event_guests(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  received_at TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  storage_state TEXT NOT NULL CHECK (storage_state IN ('pending', 'stored', 'failed')),
  drive_file_id TEXT,
  error_code TEXT,
  UNIQUE(event_id, activity_id, guest_id),
  UNIQUE(guest_id, request_key)
);
CREATE INDEX photo_submissions_contest_order ON photo_submissions(event_id, activity_id, eligible, received_at);

CREATE TABLE dedications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL REFERENCES event_guests(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  sheet_state TEXT NOT NULL DEFAULT 'pending' CHECK (sheet_state IN ('pending', 'synced', 'error')),
  UNIQUE(guest_id, id)
);

CREATE TABLE contests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first_photo', 'most_photos', 'photo_with_couple', 'bouquet', 'manual')),
  rule_json TEXT NOT NULL DEFAULT '{}',
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'inactive', 'pending', 'finished')),
  prize_id TEXT,
  validation_instructions TEXT,
  winner_guest_id TEXT REFERENCES event_guests(id) ON DELETE SET NULL,
  winner_confirmed_at TEXT,
  winner_confirmed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (opens_at < closes_at)
);
CREATE INDEX contests_by_event_state ON contests(event_id, state, opens_at, closes_at);

CREATE TABLE contest_results (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL UNIQUE REFERENCES contests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  winner_guest_id TEXT REFERENCES event_guests(id) ON DELETE SET NULL,
  calculation TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  trace_json TEXT NOT NULL DEFAULT '{}',
  calculated_at TEXT NOT NULL
);

CREATE TABLE contest_activities (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES event_activities(id) ON DELETE CASCADE,
  PRIMARY KEY(contest_id, activity_id)
);

CREATE TABLE prizes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instructions TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE prize_deliveries (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL UNIQUE REFERENCES contests(id) ON DELETE CASCADE,
  prize_id TEXT NOT NULL REFERENCES prizes(id) ON DELETE RESTRICT,
  guest_id TEXT NOT NULL REFERENCES event_guests(id) ON DELETE RESTRICT,
  staff_name TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE storage_folders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  activity_id TEXT REFERENCES event_activities(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('event', 'welcome', 'moments', 'activity', 'dedications')),
  drive_folder_id TEXT NOT NULL,
  UNIQUE(event_id, purpose, activity_id),
  UNIQUE(drive_folder_id)
);

CREATE TABLE integration_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  dedication_id TEXT REFERENCES dedications(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('init_drive', 'sync_dedication')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, dedication_id)
);
CREATE INDEX integration_jobs_due ON integration_jobs(state, next_attempt_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
