-- Supabase schema for the Firebase/Firestore -> Supabase migration of "Suivi Matériel".
-- This file defines structure only: it does not migrate data, alter Firebase, or seed fake data.

-- Extensions
create extension if not exists pgcrypto;

-- Types / enums
-- Keep roles as text because the audit found several legacy spellings (Admin, Adjoint Admin,
-- Limité, standard, adjoint, full, lecture, etc.). Values will be normalized by a later
-- migration/import step after validation.

-- Functions
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Users / profiles
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  firebase_id text unique,
  uid text unique,
  username text,
  display_name text,
  name text,
  email text unique,
  photo_url text,
  avatar_url text,
  avatar text,
  role text,
  status text,
  approved boolean,
  pending boolean,
  maintenance_authorized boolean default false,
  maintenance_access boolean default false,
  read_messages text[] default array[]::text[],
  last_login_at timestamptz,
  last_activity_at timestamptz,
  last_seen_at timestamptz,
  last_name_change_at timestamptz,
  online boolean,
  presence jsonb,
  created_at timestamptz,
  updated_at timestamptz
);

comment on table public.users is 'Application profile table linked to Supabase auth.users. Passwords, Firebase password hashes, tokens, and secrets must never be stored here.';
comment on column public.users.firebase_id is 'Original Firestore users/{userId} document ID, usually Firebase Auth uid, retained for migration mapping.';
comment on column public.users.role is 'Legacy role text retained without a CHECK until all Firebase role variants are validated and normalized.';
comment on column public.users.read_messages is 'Legacy users.readMessages array of adminMessages IDs; message_recipients.read_at is the target relational representation.';

-- Sites (Firestore: pages/page1/items/{siteId})
create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  nom text,
  owner_id uuid references public.users(id) on delete set null,
  owner_firebase_id text,
  created_by uuid references public.users(id) on delete set null,
  created_by_firebase_id text,
  created_by_name text,
  password_hash text,
  locked boolean default false,
  unlocked_by text,
  unlocked_by_name text,
  unlock_attempts_remaining integer,
  unlock_blocked_until timestamptz,
  unlock_protections jsonb,
  inactive_since timestamptz,
  inactivity_decision_pending boolean default false,
  inactivity_decision_pending_at timestamptz,
  inactivity_restored_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
);

comment on table public.sites is 'Sites migrated from pages/page1/items. Legacy Firestore IDs are stored in firebase_id for relation mapping.';
comment on column public.sites.password_hash is 'Legacy site lock hash only; do not store cleartext passwords or Base64 passwords.';
comment on column public.sites.unlock_protections is 'Temporary legacy JSONB copy of the Firestore map; site_unlock_protections is the normalized target table.';

-- OUT (Firestore: pages/page2/items/{itemId})
create table if not exists public.outs (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  site_id uuid references public.sites(id) on delete set null,
  site_firebase_id text,
  numero text,
  magasin text,
  owner_id uuid references public.users(id) on delete set null,
  owner_firebase_id text,
  created_by uuid references public.users(id) on delete set null,
  created_by_firebase_id text,
  created_by_name text,
  created_at timestamptz,
  updated_at timestamptz
);

comment on table public.outs is 'OUT/Page 2 records. site_firebase_id allows importing legacy or orphaned rows before relationship repair.';

-- OUT articles (Firestore: pages/page3/items/{detailId})
create table if not exists public.out_articles (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  site_id uuid references public.sites(id) on delete set null,
  site_firebase_id text,
  out_id uuid references public.outs(id) on delete set null,
  item_firebase_id text,
  champ integer,
  code text,
  designation text,
  qte_sortie numeric,
  unite text,
  qte_hors_btrs numeric,
  qte_retour numeric,
  date_retour timestamptz,
  qte_posee numeric,
  qte_rebus numeric,
  observation text,
  statut text,
  owner_id uuid references public.users(id) on delete set null,
  owner_firebase_id text,
  created_by uuid references public.users(id) on delete set null,
  created_by_firebase_id text,
  created_at timestamptz,
  updated_at timestamptz
);

comment on column public.out_articles.item_firebase_id is 'Legacy page3.itemId value; maps each article to its parent OUT Firestore document.';

-- Historiques (Firestore: historiques/{historyId})
create table if not exists public.historiques (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  user_id uuid references public.users(id) on delete set null,
  user_firebase_id text,
  user_name text,
  action text,
  site_id uuid references public.sites(id) on delete set null,
  site_firebase_id text,
  site_name text,
  metadata jsonb,
  created_at timestamptz
);

comment on table public.historiques is 'History entries, including existing actions and future events such as Excel exports, wrong unlock password attempts, lock/unlock events.';

-- Messages (Firestore: adminMessages/{messageId})
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  title text,
  body text,
  status text,
  created_by uuid references public.users(id) on delete set null,
  created_by_firebase_id text,
  created_at timestamptz,
  updated_at timestamptz
);

create table if not exists public.message_recipients (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references public.messages(id) on delete cascade,
  recipient_id uuid references public.users(id) on delete set null,
  recipient_firebase_id text,
  recipient_name text,
  recipient_email text,
  read_at timestamptz,
  created_at timestamptz default now(),
  unique (message_id, recipient_id),
  unique (message_id, recipient_firebase_id)
);

-- Achats (Firestore: sites/{siteId}/achatsMateriels/{purchaseId})
create table if not exists public.achats (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  site_id uuid references public.sites(id) on delete set null,
  site_firebase_id text,
  designation text,
  quantite numeric,
  magasin text,
  remark text,
  photo_url text,
  photo_provider text default 'cloudinary',
  photo_metadata jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_by_firebase_id text,
  created_by_name text,
  created_by_email text,
  created_at timestamptz,
  updated_at timestamptz
);

-- Material requests (Firestore: materialRequests/{requestId})
create table if not exists public.material_requests (
  id uuid primary key default gen_random_uuid(),
  firebase_id text unique,
  request_title text,
  requester_id uuid references public.users(id) on delete set null,
  requester_firebase_id text,
  site_id uuid references public.sites(id) on delete set null,
  site_firebase_id text,
  statut text,
  remark text,
  created_at timestamptz,
  updated_at timestamptz
);

create table if not exists public.material_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.material_requests(id) on delete cascade,
  code text,
  designation text,
  qty numeric,
  unit text,
  position integer,
  created_at timestamptz default now()
);

comment on table public.material_request_items is 'Relational representation of materialRequests.items[].';

-- Deletion limits (Firestore: users/{userId}/outDeletionLimits/{yyyy-mm-dd})
create table if not exists public.out_deletion_limits (
  id uuid primary key default gen_random_uuid(),
  firebase_id text,
  user_id uuid references public.users(id) on delete cascade,
  user_firebase_id text,
  date_key date,
  count integer default 0,
  updated_at timestamptz,
  unique (user_id, date_key),
  unique (user_firebase_id, date_key)
);

-- Unlock protections (normalized target for sites.unlockProtections)
create table if not exists public.site_unlock_protections (
  id uuid primary key default gen_random_uuid(),
  site_id uuid references public.sites(id) on delete cascade,
  site_firebase_id text,
  user_id uuid references public.users(id) on delete cascade,
  user_firebase_id text,
  attempts_remaining integer default 3,
  blocked_until timestamptz,
  has_attempted boolean default false,
  updated_at timestamptz,
  unique (site_id, user_id),
  unique (site_firebase_id, user_firebase_id)
);

-- App settings (Firestore: appSettings/{settingId}, confirmed document: maintenance)
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  enabled boolean,
  updated_by uuid references public.users(id) on delete set null,
  updated_by_firebase_id text,
  updated_at timestamptz
);

comment on table public.app_settings is 'Global application settings such as appSettings/maintenance. JSONB is limited to flexible setting payloads.';

-- Indexes
create index if not exists idx_users_firebase_id on public.users(firebase_id);
create index if not exists idx_users_role on public.users(role);
create index if not exists idx_users_created_at on public.users(created_at);

create index if not exists idx_sites_firebase_id on public.sites(firebase_id);
create index if not exists idx_sites_owner_id on public.sites(owner_id);
create index if not exists idx_sites_created_by on public.sites(created_by);
create index if not exists idx_sites_created_at on public.sites(created_at);

create index if not exists idx_outs_firebase_id on public.outs(firebase_id);
create index if not exists idx_outs_site_id on public.outs(site_id);
create index if not exists idx_outs_site_firebase_id on public.outs(site_firebase_id);
create index if not exists idx_outs_created_by on public.outs(created_by);
create index if not exists idx_outs_created_at on public.outs(created_at);

create index if not exists idx_out_articles_firebase_id on public.out_articles(firebase_id);
create index if not exists idx_out_articles_out_id on public.out_articles(out_id);
create index if not exists idx_out_articles_item_firebase_id on public.out_articles(item_firebase_id);
create index if not exists idx_out_articles_site_id on public.out_articles(site_id);
create index if not exists idx_out_articles_created_at on public.out_articles(created_at);

create index if not exists idx_historiques_firebase_id on public.historiques(firebase_id);
create index if not exists idx_historiques_user_id on public.historiques(user_id);
create index if not exists idx_historiques_site_id on public.historiques(site_id);
create index if not exists idx_historiques_created_at on public.historiques(created_at desc);

create index if not exists idx_messages_firebase_id on public.messages(firebase_id);
create index if not exists idx_messages_created_at on public.messages(created_at desc);
create index if not exists idx_message_recipients_message_id on public.message_recipients(message_id);
create index if not exists idx_message_recipients_recipient_id on public.message_recipients(recipient_id);
create index if not exists idx_message_recipients_recipient_firebase_id on public.message_recipients(recipient_firebase_id);

create index if not exists idx_achats_firebase_id on public.achats(firebase_id);
create index if not exists idx_achats_site_id on public.achats(site_id);
create index if not exists idx_achats_site_firebase_id on public.achats(site_firebase_id);
create index if not exists idx_achats_created_at on public.achats(created_at);

create index if not exists idx_material_requests_firebase_id on public.material_requests(firebase_id);
create index if not exists idx_material_requests_requester_id on public.material_requests(requester_id);
create index if not exists idx_material_requests_site_id on public.material_requests(site_id);
create index if not exists idx_material_requests_created_at on public.material_requests(created_at);
create index if not exists idx_material_request_items_request_id on public.material_request_items(request_id);

create index if not exists idx_out_deletion_limits_user_id on public.out_deletion_limits(user_id);
create index if not exists idx_out_deletion_limits_user_firebase_id on public.out_deletion_limits(user_firebase_id);
create index if not exists idx_site_unlock_protections_site_id on public.site_unlock_protections(site_id);
create index if not exists idx_site_unlock_protections_user_id on public.site_unlock_protections(user_id);

-- Triggers
do $$
begin
  create trigger set_users_updated_at before update on public.users for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create trigger set_sites_updated_at before update on public.sites for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create trigger set_outs_updated_at before update on public.outs for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create trigger set_out_articles_updated_at before update on public.out_articles for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create trigger set_messages_updated_at before update on public.messages for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create trigger set_achats_updated_at before update on public.achats for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

do $$
begin
  create trigger set_material_requests_updated_at before update on public.material_requests for each row execute function public.set_updated_at();
exception when duplicate_object then null;
end;
$$;

-- RLS
alter table public.users enable row level security;
alter table public.sites enable row level security;
alter table public.outs enable row level security;
alter table public.out_articles enable row level security;
alter table public.historiques enable row level security;
alter table public.messages enable row level security;
alter table public.message_recipients enable row level security;
alter table public.achats enable row level security;
alter table public.material_requests enable row level security;
alter table public.material_request_items enable row level security;
alter table public.out_deletion_limits enable row level security;
alter table public.site_unlock_protections enable row level security;
alter table public.app_settings enable row level security;

-- Policies / TODO
-- TODO: No Firestore rules file is present in this repository. Define precise Supabase RLS
-- policies only after exporting/validating the production Firebase rules and confirming whether
-- admin, adjoint admin/standard, limité, and lecture roles should read/write each table.
-- TODO: Add recipient-only message policies so users can read only messages addressed to them.
-- TODO: Add ownership and role policies for sites, OUT, out_articles, achats, material requests,
-- deletion limits, and unlock protections. Current code applies many checks in the frontend only.
-- TODO: During import, resolve firebase_id/site_firebase_id/item_firebase_id/user_firebase_id to UUID
-- foreign keys without deleting orphaned legacy records until anomalies are reviewed.
