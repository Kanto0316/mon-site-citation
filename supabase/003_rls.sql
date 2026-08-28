-- Phase 3: Row Level Security and API privileges.
-- Role mapping validated against current application code.
-- Firebase legacy -> Supabase app_role:
-- admin / Admin -> admin
-- standard / adjoint / adjoint admin / Adjoint Admin / full -> deputy_admin
-- limite / limité / Limité / limited / ecriture / écriture -> limited
-- lecture -> read_only
-- profiles.legacy_role is migration evidence only and is never an authorization source.
-- Historical username/email administrator shortcuts are deliberately not reproduced.
-- service_role must never be exposed to the browser.

-- Reading profiles from a profile policy would otherwise recurse through profiles RLS.
-- These no-argument SECURITY DEFINER helpers derive identity exclusively from auth.uid().
-- The explicit empty search path and fully-qualified relation prevent object shadowing.
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.role
  FROM public.profiles AS p
  WHERE p.id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(public.current_app_role() = 'admin'::public.app_role, FALSE);
$$;

CREATE OR REPLACE FUNCTION public.is_privileged_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    public.current_app_role() IN ('admin'::public.app_role, 'deputy_admin'::public.app_role),
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_data()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    public.current_app_role() IN (
      'admin'::public.app_role,
      'deputy_admin'::public.app_role,
      'limited'::public.app_role
    ),
    FALSE
  );
$$;

REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_privileged_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_privileged_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_data() TO authenticated;

-- Defense in depth: keep RLS enabled even if this phase is applied independently.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
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

-- API privileges are denied first and then granted narrowly. No business table is
-- available to anon; maintenance is evaluated after authentication in the current UI.
REVOKE ALL ON TABLE
  public.profiles, public.app_settings, public.material_codes, public.sites,
  public.outs, public.articles, public.article_returns, public.purchases,
  public.history_events, public.trash_entries, public.out_deletion_limits,
  public.material_requests, public.material_request_items, public.admin_messages,
  public.message_recipients, public.message_reads
FROM anon, authenticated;

-- PROFILES
CREATE POLICY profiles_select_self_or_management
ON public.profiles FOR SELECT TO authenticated
USING (id = auth.uid() OR public.is_privileged_admin());

CREATE POLICY profiles_insert_self
ON public.profiles FOR INSERT TO authenticated
WITH CHECK (
  id = auth.uid()
  AND role = 'limited'::public.app_role
  AND maintenance_authorized = FALSE
  AND maintenance_access = FALSE
  AND firebase_uid IS NULL
  AND firebase_id IS NULL
);

CREATE POLICY profiles_update_self_or_management
ON public.profiles FOR UPDATE TO authenticated
USING ((id = auth.uid() AND public.can_manage_data()) OR public.is_privileged_admin())
WITH CHECK ((id = auth.uid() AND public.can_manage_data()) OR public.is_privileged_admin());

CREATE POLICY profiles_delete_management
ON public.profiles FOR DELETE TO authenticated
USING (public.is_privileged_admin() AND id <> auth.uid());

GRANT SELECT, DELETE ON public.profiles TO authenticated;
GRANT INSERT (id, email, username, display_name, name, avatar_url) ON public.profiles TO authenticated;
GRANT UPDATE (
  email, username, display_name, name, avatar_url,
  last_login_at, last_activity_at, username_changed_at
) ON public.profiles TO authenticated;

-- Direct API updates can never touch role, legacy_role, maintenance flags, Firebase
-- identifiers, id, or audit timestamps. A future admin RPC must own those changes.
-- HUMAN VALIDATION REQUIRED:
-- Deputy admins currently reach users.html and its controls. They receive profile
-- visibility/deletion parity here, but role and maintenance changes remain blocked
-- until a narrowly scoped audited administrator RPC is introduced.

-- SITES: authenticated users see sites; all writers except read_only may create/edit.
CREATE POLICY sites_select_authenticated
ON public.sites FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);

CREATE POLICY sites_insert_writer
ON public.sites FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND created_by = auth.uid()
  AND (owner_id IS NULL OR owner_id = auth.uid())
);

CREATE POLICY sites_update_writer
ON public.sites FOR UPDATE TO authenticated
USING (public.can_manage_data())
WITH CHECK (public.can_manage_data());

CREATE POLICY sites_delete_admin_or_creator
ON public.sites FOR DELETE TO authenticated
USING (public.is_privileged_admin() OR created_by = auth.uid());

GRANT SELECT, DELETE ON public.sites TO authenticated;
GRANT UPDATE (name) ON public.sites TO authenticated;
GRANT INSERT (name, owner_id, created_by, created_by_name_snapshot, created_by_email_snapshot)
ON public.sites TO authenticated;

-- Legacy locking columns are intentionally neither granted nor used for authorization.

-- OUTS inherit visibility from their parent site. Limited users cannot bypass the
-- daily deletion counter with direct DELETE; privileged administrators are not counted
-- by the current application.
CREATE POLICY outs_select_parent_site
ON public.outs FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = outs.site_id));

CREATE POLICY outs_insert_writer
ON public.outs FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND created_by = auth.uid()
  AND (owner_id IS NULL OR owner_id = auth.uid())
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = outs.site_id)
);

CREATE POLICY outs_update_writer
ON public.outs FOR UPDATE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = outs.site_id)
)
WITH CHECK (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = outs.site_id)
);

CREATE POLICY outs_delete_privileged
ON public.outs FOR DELETE TO authenticated
USING (
  public.is_privileged_admin()
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = outs.site_id)
);

GRANT SELECT, DELETE ON public.outs TO authenticated;
GRANT INSERT (
  site_id, number, normalized_number, store, owner_id, created_by,
  created_by_name_snapshot, created_by_email_snapshot
) ON public.outs TO authenticated;
GRANT UPDATE (number, normalized_number, store) ON public.outs TO authenticated;

-- SECURITY REVIEW REQUIRED: increment_out_deletion_count(profile_uuid, target_date)
-- is SECURITY INVOKER and accepts an arbitrary profile UUID. It cannot safely support
-- limited-user deletion without changes to 002_functions.sql, so quota rows and limited
-- direct OUT deletion remain closed.

-- ARTICLES derive access only through out_id -> outs -> sites. articles.site_id is
-- migration denormalization and is deliberately ignored by every authorization test.
CREATE POLICY articles_select_parent_chain
ON public.articles FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.outs AS o
    JOIN public.sites AS s ON s.id = o.site_id
    WHERE o.id = articles.out_id
  )
);

CREATE POLICY articles_insert_writer
ON public.articles FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND created_by = auth.uid()
  AND (owner_id IS NULL OR owner_id = auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.outs AS o
    JOIN public.sites AS s ON s.id = o.site_id
    WHERE o.id = articles.out_id
  )
);

CREATE POLICY articles_update_writer
ON public.articles FOR UPDATE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.outs AS o WHERE o.id = articles.out_id)
)
WITH CHECK (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.outs AS o WHERE o.id = articles.out_id)
);

CREATE POLICY articles_delete_writer
ON public.articles FOR DELETE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.outs AS o WHERE o.id = articles.out_id)
);

GRANT SELECT, DELETE ON public.articles TO authenticated;
GRANT INSERT (
  out_id, field, code, designation, quantity_out, unit, quantity_outside_btrs,
  quantity_installed, quantity_scrap, observation, status, owner_id, created_by,
  created_by_name_snapshot, created_by_email_snapshot
) ON public.articles TO authenticated;
GRANT UPDATE (
  field, code, designation, quantity_out, unit, quantity_outside_btrs,
  quantity_installed, quantity_scrap, observation, status
) ON public.articles TO authenticated;

-- ARTICLE RETURNS use the complete article -> OUT -> site chain. The phase-2 RPCs are
-- SECURITY INVOKER, so these policies apply to their SELECT/INSERT/UPDATE/DELETE work.
CREATE POLICY article_returns_select_parent_chain
ON public.article_returns FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.articles AS a
    JOIN public.outs AS o ON o.id = a.out_id
    JOIN public.sites AS s ON s.id = o.site_id
    WHERE a.id = article_returns.article_id
  )
);

CREATE POLICY article_returns_insert_writer
ON public.article_returns FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND created_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.articles AS a
    JOIN public.outs AS o ON o.id = a.out_id
    JOIN public.sites AS s ON s.id = o.site_id
    WHERE a.id = article_returns.article_id
  )
);

CREATE POLICY article_returns_update_writer
ON public.article_returns FOR UPDATE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.articles AS a WHERE a.id = article_returns.article_id)
)
WITH CHECK (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.articles AS a WHERE a.id = article_returns.article_id)
);

CREATE POLICY article_returns_delete_writer
ON public.article_returns FOR DELETE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (SELECT 1 FROM public.articles AS a WHERE a.id = article_returns.article_id)
);

GRANT SELECT, DELETE ON public.article_returns TO authenticated;
GRANT INSERT (article_id, quantity, return_date, note, created_by) ON public.article_returns TO authenticated;
GRANT UPDATE (quantity, return_date, note) ON public.article_returns TO authenticated;

-- PURCHASES: the purchases tab is admin/adjoint-only in current app.js. Creation is
-- always attributed to the caller; creator and site cannot be rewritten afterward.
CREATE POLICY purchases_select_privileged
ON public.purchases FOR SELECT TO authenticated
USING (
  public.is_privileged_admin()
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = purchases.site_id)
);

CREATE POLICY purchases_insert_privileged
ON public.purchases FOR INSERT TO authenticated
WITH CHECK (
  public.is_privileged_admin()
  AND created_by = auth.uid()
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = purchases.site_id)
);

CREATE POLICY purchases_update_privileged
ON public.purchases FOR UPDATE TO authenticated
USING (public.is_privileged_admin())
WITH CHECK (
  public.is_privileged_admin()
  AND EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = purchases.site_id)
);

CREATE POLICY purchases_delete_privileged
ON public.purchases FOR DELETE TO authenticated
USING (public.is_privileged_admin());

GRANT SELECT, DELETE ON public.purchases TO authenticated;
GRANT INSERT (
  site_id, designation, quantity, unit, store, remark, image_url, image_public_id,
  image_provider, created_by, created_by_name_snapshot, created_by_email_snapshot
) ON public.purchases TO authenticated;
GRANT UPDATE (
  designation, quantity, unit, store, remark, image_url, image_public_id, image_provider
) ON public.purchases TO authenticated;

-- MATERIAL CODES
CREATE POLICY material_codes_select_authenticated
ON public.material_codes FOR SELECT TO authenticated
USING (auth.uid() IS NOT NULL);

CREATE POLICY material_codes_insert_writer
ON public.material_codes FOR INSERT TO authenticated
WITH CHECK (public.can_manage_data());

CREATE POLICY material_codes_update_writer
ON public.material_codes FOR UPDATE TO authenticated
USING (public.can_manage_data())
WITH CHECK (public.can_manage_data());

CREATE POLICY material_codes_delete_admin
ON public.material_codes FOR DELETE TO authenticated
USING (public.is_admin());

GRANT SELECT, DELETE ON public.material_codes TO authenticated;
GRANT INSERT (code, normalized_code, designation) ON public.material_codes TO authenticated;
GRANT UPDATE (code, normalized_code, designation) ON public.material_codes TO authenticated;

-- HISTORY EVENTS are append-only from the browser. The history screen is limited to
-- administrators/deputies; writers may append only events attributed to themselves.
CREATE POLICY history_events_select_privileged
ON public.history_events FOR SELECT TO authenticated
USING (public.is_privileged_admin());

CREATE POLICY history_events_insert_writer
ON public.history_events FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND actor_id = auth.uid()
  AND (site_id IS NULL OR EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = history_events.site_id))
);

GRANT SELECT ON public.history_events TO authenticated;
GRANT INSERT (
  actor_id, actor_name_snapshot, actor_email_snapshot, action, site_id,
  site_name_snapshot, metadata
) ON public.history_events TO authenticated;

-- TRASH snapshots are sensitive. There is read-only privileged visibility and no
-- browser mutation privilege. Restore/purge/create must move to secured server RPCs.
CREATE POLICY trash_entries_select_privileged
ON public.trash_entries FOR SELECT TO authenticated
USING (public.is_privileged_admin());

GRANT SELECT ON public.trash_entries TO authenticated;

-- SECURITY REVIEW REQUIRED: create_trash_entry, mark_trash_entry_restored, and
-- purge_expired_trash are SECURITY INVOKER. Granting the table writes they require
-- would expose payload/deleted_by/deleted_at or direct purge, so they intentionally
-- cannot be called by browser roles in this phase.

-- APP SETTINGS: maintenance is needed only after auth resolves; trash visibility and
-- every setting change remain privileged. No anon policy or privilege is created.
CREATE POLICY app_settings_select_maintenance
ON public.app_settings FOR SELECT TO authenticated
USING (key = 'maintenance');

CREATE POLICY app_settings_select_privileged
ON public.app_settings FOR SELECT TO authenticated
USING (public.is_privileged_admin());

CREATE POLICY app_settings_insert_admin
ON public.app_settings FOR INSERT TO authenticated
WITH CHECK (public.is_admin() AND updated_by = auth.uid());

CREATE POLICY app_settings_update_admin
ON public.app_settings FOR UPDATE TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin() AND updated_by = auth.uid());

CREATE POLICY app_settings_delete_admin
ON public.app_settings FOR DELETE TO authenticated
USING (public.is_admin());

GRANT SELECT, DELETE ON public.app_settings TO authenticated;
GRANT INSERT (key, value, updated_by) ON public.app_settings TO authenticated;
GRANT UPDATE (value, updated_by) ON public.app_settings TO authenticated;

-- HUMAN VALIDATION REQUIRED:
-- Current code lets deputy admins reach the maintenance UI, but the requested model
-- warns against assuming full admin parity. Setting writes are therefore admin-only.

-- OUT DELETION LIMITS: self-read only, with no direct browser writes.
CREATE POLICY out_deletion_limits_select_self
ON public.out_deletion_limits FOR SELECT TO authenticated
USING (profile_id = auth.uid());

GRANT SELECT ON public.out_deletion_limits TO authenticated;

-- SECURITY REVIEW REQUIRED: increment_out_deletion_count is SECURITY INVOKER and
-- accepts arbitrary profile_uuid. Keep INSERT/UPDATE/DELETE revoked until it derives
-- profile_id from auth.uid() in a revised 002_functions.sql.

-- MATERIAL REQUESTS: request owners and privileged admins see the request; items have
-- no independent access and always inherit the parent request decision.
CREATE POLICY material_requests_select_owner_or_privileged
ON public.material_requests FOR SELECT TO authenticated
USING (requester_id = auth.uid() OR public.is_privileged_admin());

CREATE POLICY material_requests_insert_writer
ON public.material_requests FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND requester_id = auth.uid()
  AND (site_id IS NULL OR EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = material_requests.site_id))
);

CREATE POLICY material_requests_update_owner_or_privileged
ON public.material_requests FOR UPDATE TO authenticated
USING (public.can_manage_data() AND (requester_id = auth.uid() OR public.is_privileged_admin()))
WITH CHECK (
  public.can_manage_data()
  AND (requester_id = auth.uid() OR public.is_privileged_admin())
  AND (site_id IS NULL OR EXISTS (SELECT 1 FROM public.sites AS s WHERE s.id = material_requests.site_id))
);

CREATE POLICY material_requests_delete_owner_or_privileged
ON public.material_requests FOR DELETE TO authenticated
USING (public.can_manage_data() AND (requester_id = auth.uid() OR public.is_privileged_admin()));

GRANT SELECT, DELETE ON public.material_requests TO authenticated;
GRANT INSERT (request_title, requester_id, site_id, status) ON public.material_requests TO authenticated;
GRANT UPDATE (request_title, site_id, status) ON public.material_requests TO authenticated;

CREATE POLICY material_request_items_select_parent
ON public.material_request_items FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.material_requests AS mr
    WHERE mr.id = material_request_items.request_id
      AND (mr.requester_id = auth.uid() OR public.is_privileged_admin())
  )
);

CREATE POLICY material_request_items_insert_parent
ON public.material_request_items FOR INSERT TO authenticated
WITH CHECK (
  public.can_manage_data()
  AND EXISTS (
    SELECT 1 FROM public.material_requests AS mr
    WHERE mr.id = material_request_items.request_id
      AND (mr.requester_id = auth.uid() OR public.is_privileged_admin())
  )
);

CREATE POLICY material_request_items_update_parent
ON public.material_request_items FOR UPDATE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (
    SELECT 1 FROM public.material_requests AS mr
    WHERE mr.id = material_request_items.request_id
      AND (mr.requester_id = auth.uid() OR public.is_privileged_admin())
  )
)
WITH CHECK (
  public.can_manage_data()
  AND EXISTS (
    SELECT 1 FROM public.material_requests AS mr
    WHERE mr.id = material_request_items.request_id
      AND (mr.requester_id = auth.uid() OR public.is_privileged_admin())
  )
);

CREATE POLICY material_request_items_delete_parent
ON public.material_request_items FOR DELETE TO authenticated
USING (
  public.can_manage_data()
  AND EXISTS (
    SELECT 1 FROM public.material_requests AS mr
    WHERE mr.id = material_request_items.request_id
      AND (mr.requester_id = auth.uid() OR public.is_privileged_admin())
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_request_items TO authenticated;

-- ADMIN MESSAGES and recipients. A recipient sees only messages linked to their UID;
-- users cannot add recipients. Admin/deputy creation matches the current users page.
CREATE POLICY admin_messages_select_recipient_or_privileged
ON public.admin_messages FOR SELECT TO authenticated
USING (
  public.is_privileged_admin()
  OR EXISTS (
    SELECT 1 FROM public.message_recipients AS mr
    WHERE mr.message_id = admin_messages.id
      AND mr.profile_id = auth.uid()
  )
);

CREATE POLICY admin_messages_insert_privileged
ON public.admin_messages FOR INSERT TO authenticated
WITH CHECK (public.is_privileged_admin() AND created_by = auth.uid());

CREATE POLICY admin_messages_update_privileged
ON public.admin_messages FOR UPDATE TO authenticated
USING (public.is_privileged_admin())
WITH CHECK (public.is_privileged_admin());

CREATE POLICY admin_messages_delete_privileged
ON public.admin_messages FOR DELETE TO authenticated
USING (public.is_privileged_admin());

GRANT SELECT, DELETE ON public.admin_messages TO authenticated;
GRANT INSERT (title, body, recipient_mode, created_by) ON public.admin_messages TO authenticated;
GRANT UPDATE (title, body, recipient_mode) ON public.admin_messages TO authenticated;

CREATE POLICY message_recipients_select_self_or_privileged
ON public.message_recipients FOR SELECT TO authenticated
USING (profile_id = auth.uid() OR public.is_privileged_admin());

CREATE POLICY message_recipients_insert_privileged
ON public.message_recipients FOR INSERT TO authenticated
WITH CHECK (
  public.is_privileged_admin()
  AND EXISTS (SELECT 1 FROM public.admin_messages AS am WHERE am.id = message_recipients.message_id)
  AND EXISTS (SELECT 1 FROM public.profiles AS p WHERE p.id = message_recipients.profile_id)
);

CREATE POLICY message_recipients_delete_privileged
ON public.message_recipients FOR DELETE TO authenticated
USING (public.is_privileged_admin());

GRANT SELECT, INSERT, DELETE ON public.message_recipients TO authenticated;

-- MESSAGE READS: immutable receipts owned by the caller. mark_message_read() is
-- SECURITY INVOKER and supplies auth.uid(), so it remains constrained by this policy.
CREATE POLICY message_reads_select_self
ON public.message_reads FOR SELECT TO authenticated
USING (profile_id = auth.uid());

CREATE POLICY message_reads_insert_self_recipient
ON public.message_reads FOR INSERT TO authenticated
WITH CHECK (
  profile_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.message_recipients AS mr
    WHERE mr.message_id = message_reads.message_id
      AND mr.profile_id = auth.uid()
  )
);

GRANT SELECT ON public.message_reads TO authenticated;
GRANT INSERT (message_id, profile_id, read_at) ON public.message_reads TO authenticated;

-- RLS TEST MATRIX
-- ADMIN
-- - read/write sites, OUTs, articles, returns, purchases, settings and catalogue.
-- - read/manage users, messages, recipients, requests and sensitive trash snapshots.
-- - profile privileged-column mutation requires the future audited RPC.
-- DEPUTY ADMIN
-- - read/write operational data and purchases; read/manage requests/messages/users.
-- - cannot change app settings or destroy material codes; validate these boundaries.
-- LIMITED
-- - read sites/OUTs/articles/catalogue; create/edit operational rows and own requests.
-- - cannot read purchases/history/trash/users of others or directly delete OUTs.
-- READ ONLY
-- - read sites/OUTs/articles/catalogue, own profile/requests/messages/read receipts.
-- - every INSERT, UPDATE and DELETE attempt must be refused.
-- USER A vs USER B
-- - change own role to admin -> REFUSED (column privilege).
-- - modify created_by/actor_id/deleted_by/requester_id -> REFUSED.
-- - read another user's profile, request, message or message_reads -> REFUSED.
-- - write message_reads for another UID or a non-recipient message -> REFUSED.
-- - add oneself/another user as message recipient -> REFUSED.
-- - access article/return through an inaccessible parent chain -> REFUSED.
-- - insert an article with forged articles.site_id -> authorization still uses OUT chain.
-- - directly change/delete a quota row -> REFUSED.
-- - insert/update/delete trash payload or purge trash -> REFUSED.
-- - read_only INSERT into every business table -> REFUSED.
-- ANON
-- - no table privileges and no policies; maintenance/settings/business reads refused.
-- SERVICE ROLE
-- - server-only bypass behavior is not modeled by policies; never use its key in a client.
