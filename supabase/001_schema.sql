-- Phase 1: initial PostgreSQL schema for the Firebase -> Supabase migration.
-- Source of truth: FIREBASE_TO_SUPABASE_AUDIT.md (repository audit).
-- Structure only: RLS is enabled without policies; no RPC, Realtime, data import,
-- or business triggers are defined in this phase.

-- Required by gen_random_uuid(). CITEXT provides case-insensitive profile identifiers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Migration note: historical role variants are mapped as follows:
-- admin -> admin; standard/adjoint/adjoint admin/Adjoint Admin/full -> deputy_admin;
-- limite/Limité/limited/ecriture -> limited; lecture -> read_only.
-- profiles.legacy_role retains the original value so migration is lossless.
CREATE TYPE public.app_role AS ENUM (
  'admin',
  'deputy_admin',
  'limited',
  'read_only'
);

-- updated_at is initialized here but will only be maintained automatically in a later file.

-- Source Firebase: users/{uid}.
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  firebase_id TEXT,
  firebase_uid TEXT,
  email CITEXT,
  username CITEXT,
  display_name TEXT,
  name TEXT,
  avatar_url TEXT,
  role public.app_role NOT NULL DEFAULT 'limited',
  legacy_role TEXT,
  legacy_status TEXT,
  legacy_approved BOOLEAN,
  legacy_pending BOOLEAN,
  presence TEXT,
  online BOOLEAN,
  last_seen_at TIMESTAMPTZ,
  maintenance_authorized BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_access BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  username_changed_at TIMESTAMPTZ,
  CONSTRAINT profiles_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT profiles_firebase_uid_key UNIQUE (firebase_uid),
  CONSTRAINT profiles_email_key UNIQUE (email),
  CONSTRAINT profiles_username_key UNIQUE (username)
);

COMMENT ON COLUMN public.profiles.firebase_id IS
  'Original Firestore users/{uid} document ID. Usually equal to firebase_uid, but retained separately for explicit document mapping.';
COMMENT ON COLUMN public.profiles.legacy_role IS
  'Original Firebase role spelling retained during migration; remove after role mapping validation.';
COMMENT ON COLUMN public.profiles.legacy_status IS
  'Legacy Firebase status retained for migration evidence only; it is not an authorization source.';
COMMENT ON COLUMN public.profiles.legacy_approved IS
  'Legacy Firebase approved flag retained for migration evidence only; it is not an authorization source.';
COMMENT ON COLUMN public.profiles.legacy_pending IS
  'Legacy Firebase pending flag retained for migration evidence only; it is not an authorization source.';
COMMENT ON COLUMN public.profiles.presence IS
  'Legacy Firebase presence value retained without assigning new business semantics.';
COMMENT ON COLUMN public.profiles.online IS
  'Legacy Firebase online value retained without assigning new business semantics.';
COMMENT ON COLUMN public.profiles.last_seen_at IS
  'Legacy Firebase lastSeen/lastSeenAt timestamp retained without assigning new business semantics.';

-- Source Firebase: appSettings/maintenance and appSettings/trash.
CREATE TABLE public.app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_not_blank CHECK (btrim(key) <> '')
);

-- Source Firebase: materialCodes/{id}.
CREATE TABLE public.material_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL,
  designation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT material_codes_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT material_codes_normalized_code_key UNIQUE (normalized_code),
  CONSTRAINT material_codes_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT material_codes_normalized_code_not_blank CHECK (btrim(normalized_code) <> ''),
  CONSTRAINT material_codes_designation_not_blank CHECK (btrim(designation) <> '')
);

CREATE INDEX material_codes_code_idx ON public.material_codes (code);

-- Source Firebase: pages/page1/items/{siteId}.
CREATE TABLE public.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  name TEXT NOT NULL,
  owner_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  out_count_legacy INTEGER,
  created_by_name_snapshot TEXT,
  created_by_email_snapshot TEXT,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash_legacy TEXT,
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  locked_by_name_snapshot TEXT,
  unlocked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  unlocked_by_name_snapshot TEXT,
  unlock_attempts_remaining INTEGER,
  unlock_blocked_until TIMESTAMPTZ,
  inactive_since TIMESTAMPTZ,
  inactivity_decision_pending BOOLEAN NOT NULL DEFAULT FALSE,
  inactivity_decision_pending_at TIMESTAMPTZ,
  inactivity_restored_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sites_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT sites_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT sites_out_count_legacy_nonnegative CHECK (out_count_legacy IS NULL OR out_count_legacy >= 0),
  CONSTRAINT sites_unlock_attempts_nonnegative CHECK (unlock_attempts_remaining IS NULL OR unlock_attempts_remaining >= 0)
);

COMMENT ON COLUMN public.sites.out_count_legacy IS
  'Legacy Firebase value. Not authoritative in PostgreSQL.';
COMMENT ON COLUMN public.sites.password_hash_legacy IS
  'Legacy frontend lock value retained only for migration parity; it is not a Supabase authorization mechanism and should later be removed.';
COMMENT ON COLUMN public.sites.unlock_attempts_remaining IS
  'Legacy frontend lock state retained for migration parity; it should later be replaced or removed.';
COMMENT ON COLUMN public.sites.unlock_blocked_until IS
  'Legacy frontend lock state retained for migration parity; it should later be replaced or removed.';
COMMENT ON COLUMN public.sites.unlocked_by IS
  'Historical unlock actor reference retained for migration only; it does not define authorization.';
COMMENT ON COLUMN public.sites.unlocked_by_name_snapshot IS
  'Historical unlock actor name snapshot retained for migration only; it does not define authorization.';

-- Legacy Firebase source: sites.unlockProtections
-- Migration preservation table.
-- This table does not itself define authorization.
CREATE TABLE public.site_unlock_protections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  attempts_remaining INTEGER NOT NULL,
  blocked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_unlock_protections_site_profile_key UNIQUE (site_id, profile_id),
  CONSTRAINT site_unlock_protections_attempts_range CHECK (
    attempts_remaining >= 0 AND attempts_remaining <= 3
  )
);

-- Source Firebase: pages/page2/items/{itemId}.
-- Relation: a business OUT belongs to one site; deletion is restricted for trash/restore workflows.
CREATE TABLE public.outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  normalized_number TEXT NOT NULL,
  store TEXT,
  owner_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  article_count_legacy INTEGER,
  created_by_name_snapshot TEXT,
  created_by_email_snapshot TEXT,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outs_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT outs_site_normalized_number_key UNIQUE (site_id, normalized_number),
  CONSTRAINT outs_number_not_blank CHECK (btrim(number) <> ''),
  CONSTRAINT outs_normalized_number_not_blank CHECK (btrim(normalized_number) <> ''),
  CONSTRAINT outs_article_count_legacy_nonnegative CHECK (article_count_legacy IS NULL OR article_count_legacy >= 0)
);

COMMENT ON COLUMN public.outs.normalized_number IS
  'Canonical OUT number populated by writers/importers (trimmed and case-normalized); avoids a generated column or trigger in phase 1.';
COMMENT ON COLUMN public.outs.article_count_legacy IS
  'Legacy Firebase value. Not authoritative in PostgreSQL.';

-- Source Firebase: pages/page3/items/{detailId}.
CREATE TABLE public.articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  out_id UUID NOT NULL REFERENCES public.outs(id) ON DELETE RESTRICT,
  site_id UUID REFERENCES public.sites(id) ON DELETE RESTRICT,
  field INTEGER,
  code TEXT,
  designation TEXT,
  quantity_out NUMERIC,
  unit TEXT,
  quantity_outside_btrs NUMERIC,
  quantity_returned_legacy NUMERIC,
  return_date_legacy DATE,
  quantity_installed NUMERIC,
  quantity_scrap NUMERIC,
  observation TEXT,
  status TEXT,
  owner_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by_name_snapshot TEXT,
  created_by_email_snapshot TEXT,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT articles_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT articles_quantity_out_nonnegative CHECK (quantity_out IS NULL OR quantity_out >= 0),
  CONSTRAINT articles_quantity_outside_btrs_nonnegative CHECK (quantity_outside_btrs IS NULL OR quantity_outside_btrs >= 0),
  CONSTRAINT articles_quantity_returned_legacy_nonnegative CHECK (quantity_returned_legacy IS NULL OR quantity_returned_legacy >= 0),
  CONSTRAINT articles_quantity_installed_nonnegative CHECK (quantity_installed IS NULL OR quantity_installed >= 0),
  CONSTRAINT articles_quantity_scrap_nonnegative CHECK (quantity_scrap IS NULL OR quantity_scrap >= 0)
);

COMMENT ON COLUMN public.articles.site_id IS
  'Firebase denormalization redundant with outs.site_id; retain for migration validation, then remove after reconciliation.';
COMMENT ON COLUMN public.articles.quantity_returned_legacy IS
  'Legacy aggregate Firebase return quantity; article_returns becomes authoritative after migration validation.';
COMMENT ON COLUMN public.articles.return_date_legacy IS
  'Legacy Firebase dateRetour value; article_returns becomes authoritative after migration validation.';

-- Source Firebase: embedded pages/page3/items/{detailId}.returns[].
CREATE TABLE public.article_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_return_id TEXT,
  article_id UUID NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  quantity NUMERIC NOT NULL,
  return_date DATE,
  note TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_legacy BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT article_returns_article_firebase_return_key UNIQUE (article_id, firebase_return_id),
  CONSTRAINT article_returns_quantity_positive CHECK (quantity > 0)
);

COMMENT ON CONSTRAINT article_returns_article_firebase_return_key ON public.article_returns IS
  'Firebase return IDs are scoped to the parent article. PostgreSQL permits multiple NULL IDs while making identified imports idempotent.';
COMMENT ON COLUMN public.article_returns.return_date IS
  'A DATE matches the current date-only HTML/Firebase semantics; validate before importing non-date timestamp values.';

-- Source Firebase: sites/{siteId}/achatsMateriels/{purchaseId}.
CREATE TABLE public.purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE RESTRICT,
  designation TEXT NOT NULL,
  quantity NUMERIC,
  unit TEXT,
  store TEXT,
  remark TEXT,
  image_url TEXT,
  image_public_id TEXT,
  image_provider TEXT NOT NULL DEFAULT 'cloudinary',
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by_name_snapshot TEXT,
  created_by_email_snapshot TEXT,
  site_name_snapshot TEXT,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by_name_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchases_site_firebase_id_key UNIQUE (site_id, firebase_id),
  CONSTRAINT purchases_designation_not_blank CHECK (btrim(designation) <> ''),
  CONSTRAINT purchases_quantity_nonnegative CHECK (quantity IS NULL OR quantity >= 0)
);

COMMENT ON CONSTRAINT purchases_site_firebase_id_key ON public.purchases IS
  'Purchase document IDs are unique only inside each site achatsMateriels subcollection, so migration identity is (site_id, firebase_id).';

-- Source Firebase: historiques/{historyId}.
CREATE TABLE public.history_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_name_snapshot TEXT,
  actor_email_snapshot TEXT,
  action TEXT NOT NULL,
  site_id UUID REFERENCES public.sites(id) ON DELETE SET NULL,
  site_name_snapshot TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT history_events_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT history_events_action_not_blank CHECK (btrim(action) <> '')
);

-- Source Firebase: trash/{trashId}.
CREATE TABLE public.trash_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  entity_type TEXT NOT NULL,
  original_firebase_id TEXT,
  payload JSONB NOT NULL,
  deleted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  deleted_by_name_snapshot TEXT,
  deleted_by_email_snapshot TEXT,
  deleted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  CONSTRAINT trash_entries_firebase_id_key UNIQUE (firebase_id),
  CONSTRAINT trash_entries_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT trash_entries_expiry_order CHECK (expires_at >= deleted_at),
  CONSTRAINT trash_entries_restore_order CHECK (restored_at IS NULL OR restored_at >= deleted_at)
);

-- Source Firebase: users/{uid}/outDeletionLimits/{yyyy-mm-dd}.
CREATE TABLE public.out_deletion_limits (
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  limit_date DATE NOT NULL,
  deletion_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, limit_date),
  CONSTRAINT out_deletion_limits_count_nonnegative CHECK (deletion_count >= 0)
);

-- Source Firebase: materialRequests/{requestId}.
-- Legacy rows may not contain requester/site/status.
CREATE TABLE public.material_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  request_title TEXT,
  requester_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  site_id UUID REFERENCES public.sites(id) ON DELETE RESTRICT,
  status TEXT,
  remark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT material_requests_firebase_id_key UNIQUE (firebase_id)
);

COMMENT ON TABLE public.material_requests IS
  'Legacy rows may not contain requester/site/status.';

-- Relation: normalized representation of materialRequests.items[].
-- CASCADE is safe here because an item has no meaning outside its request.
CREATE TABLE public.material_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.material_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  code TEXT,
  designation TEXT,
  quantity NUMERIC,
  unit TEXT,
  CONSTRAINT material_request_items_request_position_key UNIQUE (request_id, position),
  CONSTRAINT material_request_items_position_nonnegative CHECK (position >= 0),
  CONSTRAINT material_request_items_quantity_nonnegative CHECK (quantity IS NULL OR quantity >= 0)
);

-- Source Firebase: adminMessages/{messageId}.
CREATE TABLE public.admin_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_id TEXT,
  title TEXT,
  body TEXT,
  title_template TEXT,
  body_template TEXT,
  recipient_mode TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_messages_firebase_id_key UNIQUE (firebase_id)
);

-- Relation: normalized representation of adminMessages.recipientIds[].
-- CASCADE removes only recipient links when their parent message is removed.
CREATE TABLE public.message_recipients (
  message_id UUID NOT NULL REFERENCES public.admin_messages(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_name_snapshot TEXT,
  recipient_email_snapshot TEXT,
  PRIMARY KEY (message_id, profile_id)
);

-- Relation: replacement for users.readMessages[].
-- CASCADE removes only read receipts when their parent message is removed.
CREATE TABLE public.message_reads (
  message_id UUID NOT NULL REFERENCES public.admin_messages(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_synthetic_timestamp BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (message_id, profile_id)
);

-- Migration note: automatic updated_at maintenance intentionally belongs in
-- 002_functions.sql. This schema only supplies initial DEFAULT now() values.

-- Structural indexes for foreign-key joins and the principal chronological reads.
-- Primary-key and UNIQUE constraints already create their own backing indexes.
CREATE INDEX profiles_created_at_idx ON public.profiles (created_at);
CREATE INDEX app_settings_updated_by_idx ON public.app_settings (updated_by);
CREATE INDEX sites_owner_id_idx ON public.sites (owner_id);
CREATE INDEX sites_created_by_idx ON public.sites (created_by);
CREATE INDEX sites_locked_by_idx ON public.sites (locked_by);
CREATE INDEX sites_unlocked_by_idx ON public.sites (unlocked_by);
CREATE INDEX sites_created_at_idx ON public.sites (created_at);
CREATE INDEX site_unlock_protections_site_id_idx ON public.site_unlock_protections (site_id);
CREATE INDEX site_unlock_protections_profile_id_idx ON public.site_unlock_protections (profile_id);
CREATE INDEX outs_site_id_idx ON public.outs (site_id);
CREATE INDEX outs_owner_id_idx ON public.outs (owner_id);
CREATE INDEX outs_created_by_idx ON public.outs (created_by);
CREATE INDEX outs_created_at_idx ON public.outs (created_at);
CREATE INDEX articles_out_id_idx ON public.articles (out_id);
CREATE INDEX articles_site_id_idx ON public.articles (site_id);
CREATE INDEX articles_owner_id_idx ON public.articles (owner_id);
CREATE INDEX articles_created_by_idx ON public.articles (created_by);
CREATE INDEX article_returns_article_id_idx ON public.article_returns (article_id);
CREATE INDEX article_returns_created_by_idx ON public.article_returns (created_by);
CREATE INDEX purchases_site_id_idx ON public.purchases (site_id);
CREATE INDEX purchases_created_by_idx ON public.purchases (created_by);
CREATE INDEX purchases_updated_by_idx ON public.purchases (updated_by);
CREATE INDEX purchases_created_at_idx ON public.purchases (created_at);
CREATE INDEX history_events_actor_id_idx ON public.history_events (actor_id);
CREATE INDEX history_events_site_id_idx ON public.history_events (site_id);
CREATE INDEX history_events_created_at_idx ON public.history_events (created_at DESC);
CREATE INDEX trash_entries_deleted_by_idx ON public.trash_entries (deleted_by);
CREATE INDEX trash_entries_deleted_at_idx ON public.trash_entries (deleted_at DESC);
CREATE INDEX trash_entries_expires_at_idx ON public.trash_entries (expires_at);
CREATE INDEX material_requests_requester_id_idx ON public.material_requests (requester_id);
CREATE INDEX material_requests_site_id_idx ON public.material_requests (site_id);
CREATE INDEX material_requests_created_at_idx ON public.material_requests (created_at);
CREATE INDEX material_request_items_request_id_idx ON public.material_request_items (request_id);
CREATE INDEX admin_messages_created_by_idx ON public.admin_messages (created_by);
CREATE INDEX admin_messages_created_at_idx ON public.admin_messages (created_at DESC);
CREATE INDEX message_recipients_profile_id_idx ON public.message_recipients (profile_id);
CREATE INDEX message_reads_profile_id_idx ON public.message_reads (profile_id);

-- Phase 1 deliberately enables RLS without defining policies. Until the policy
-- phase is applied, API roles subject to RLS have no implicit table access.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_unlock_protections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.article_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.history_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trash_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.out_deletion_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reads ENABLE ROW LEVEL SECURITY;
