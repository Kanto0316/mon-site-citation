-- Phase 4: read-only Supabase staging preflight.
-- Sources of truth: 001_schema.sql, 002_functions.sql, and 003_rls.sql.
-- Every statement is diagnostic only and can be run independently unless noted.

-- ==================================================
-- 01. EXTENSIONS
-- ==================================================
-- EXPECTED RESULT: pgcrypto and citext are PRESENT.
WITH expected(extension_name) AS (
  SELECT unnest(ARRAY['pgcrypto', 'citext']::text[])
)
SELECT e.extension_name,
       x.extversion AS installed_version,
       CASE WHEN x.oid IS NULL THEN 'MISSING' ELSE 'PRESENT' END AS status
FROM expected e
LEFT JOIN pg_catalog.pg_extension x ON x.extname = e.extension_name
ORDER BY e.extension_name;

-- ==================================================
-- 02. TABLES
-- ==================================================
-- EXPECTED RESULT: 17/17 tables, all with RLS enabled.
WITH expected(table_name) AS (
  SELECT unnest(ARRAY[
    'profiles','app_settings','material_codes','sites','site_unlock_protections','outs','articles',
    'article_returns','purchases','history_events','trash_entries',
    'out_deletion_limits','material_requests','material_request_items',
    'admin_messages','message_recipients','message_reads'
  ]::text[])
), actual AS (
  SELECT c.oid, c.relname, c.relrowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
)
SELECT e.table_name,
       (a.oid IS NOT NULL) AS exists,
       COALESCE(a.relrowsecurity, false) AS rls_enabled
FROM expected e
LEFT JOIN actual a ON a.relname=e.table_name
ORDER BY e.table_name;

WITH expected(table_name) AS (
  SELECT unnest(ARRAY[
    'profiles','app_settings','material_codes','sites','site_unlock_protections','outs','articles',
    'article_returns','purchases','history_events','trash_entries',
    'out_deletion_limits','material_requests','material_request_items',
    'admin_messages','message_recipients','message_reads'
  ]::text[])
), found AS (
  SELECT e.table_name
  FROM expected e
  JOIN information_schema.tables t
    ON t.table_schema = 'public' AND t.table_name = e.table_name
)
SELECT 17 AS expected_tables,
       count(f.table_name) AS found_tables,
       17 - count(f.table_name) AS missing_tables
FROM found f;

-- ==================================================
-- 03. COLONNES
-- ==================================================
-- EXPECTED RESULT: every schema column below is PRESENT.
WITH expected(table_name, column_name) AS (
  VALUES
    ('profiles', 'id'),
    ('profiles', 'firebase_id'),
    ('profiles', 'firebase_uid'),
    ('profiles', 'email'),
    ('profiles', 'username'),
    ('profiles', 'display_name'),
    ('profiles', 'name'),
    ('profiles', 'avatar_url'),
    ('profiles', 'role'),
    ('profiles', 'legacy_role'),
    ('profiles', 'legacy_status'),
    ('profiles', 'legacy_approved'),
    ('profiles', 'legacy_pending'),
    ('profiles', 'presence'),
    ('profiles', 'online'),
    ('profiles', 'last_seen_at'),
    ('profiles', 'maintenance_authorized'),
    ('profiles', 'maintenance_access'),
    ('profiles', 'created_at'),
    ('profiles', 'updated_at'),
    ('profiles', 'last_login_at'),
    ('profiles', 'last_activity_at'),
    ('profiles', 'username_changed_at'),
    ('app_settings', 'key'),
    ('app_settings', 'value'),
    ('app_settings', 'updated_by'),
    ('app_settings', 'updated_at'),
    ('material_codes', 'id'),
    ('material_codes', 'firebase_id'),
    ('material_codes', 'code'),
    ('material_codes', 'normalized_code'),
    ('material_codes', 'designation'),
    ('material_codes', 'created_at'),
    ('material_codes', 'updated_at'),
    ('sites', 'id'),
    ('sites', 'firebase_id'),
    ('sites', 'name'),
    ('sites', 'owner_id'),
    ('sites', 'created_by'),
    ('sites', 'out_count_legacy'),
    ('sites', 'created_by_name_snapshot'),
    ('sites', 'created_by_email_snapshot'),
    ('sites', 'is_locked'),
    ('sites', 'password_hash_legacy'),
    ('sites', 'locked_at'),
    ('sites', 'locked_by'),
    ('sites', 'locked_by_name_snapshot'),
    ('sites', 'unlocked_by'),
    ('sites', 'unlocked_by_name_snapshot'),
    ('sites', 'unlock_attempts_remaining'),
    ('sites', 'unlock_blocked_until'),
    ('sites', 'inactive_since'),
    ('sites', 'inactivity_decision_pending'),
    ('sites', 'inactivity_decision_pending_at'),
    ('sites', 'inactivity_restored_at'),
    ('sites', 'imported_at'),
    ('sites', 'created_at'),
    ('sites', 'updated_at'),
    ('site_unlock_protections', 'id'),
    ('site_unlock_protections', 'site_id'),
    ('site_unlock_protections', 'profile_id'),
    ('site_unlock_protections', 'attempts_remaining'),
    ('site_unlock_protections', 'blocked_until'),
    ('site_unlock_protections', 'created_at'),
    ('site_unlock_protections', 'updated_at'),
    ('outs', 'id'),
    ('outs', 'firebase_id'),
    ('outs', 'site_id'),
    ('outs', 'number'),
    ('outs', 'normalized_number'),
    ('outs', 'store'),
    ('outs', 'owner_id'),
    ('outs', 'created_by'),
    ('outs', 'article_count_legacy'),
    ('outs', 'created_by_name_snapshot'),
    ('outs', 'created_by_email_snapshot'),
    ('outs', 'imported_at'),
    ('outs', 'created_at'),
    ('outs', 'updated_at'),
    ('articles', 'id'),
    ('articles', 'firebase_id'),
    ('articles', 'out_id'),
    ('articles', 'site_id'),
    ('articles', 'field'),
    ('articles', 'code'),
    ('articles', 'designation'),
    ('articles', 'quantity_out'),
    ('articles', 'unit'),
    ('articles', 'quantity_outside_btrs'),
    ('articles', 'quantity_returned_legacy'),
    ('articles', 'return_date_legacy'),
    ('articles', 'quantity_installed'),
    ('articles', 'quantity_scrap'),
    ('articles', 'observation'),
    ('articles', 'status'),
    ('articles', 'owner_id'),
    ('articles', 'created_by'),
    ('articles', 'created_by_name_snapshot'),
    ('articles', 'created_by_email_snapshot'),
    ('articles', 'imported_at'),
    ('articles', 'created_at'),
    ('articles', 'updated_at'),
    ('article_returns', 'id'),
    ('article_returns', 'firebase_return_id'),
    ('article_returns', 'article_id'),
    ('article_returns', 'quantity'),
    ('article_returns', 'return_date'),
    ('article_returns', 'note'),
    ('article_returns', 'created_by'),
    ('article_returns', 'created_at'),
    ('article_returns', 'is_legacy'),
    ('purchases', 'id'),
    ('purchases', 'firebase_id'),
    ('purchases', 'site_id'),
    ('purchases', 'designation'),
    ('purchases', 'quantity'),
    ('purchases', 'unit'),
    ('purchases', 'store'),
    ('purchases', 'remark'),
    ('purchases', 'image_url'),
    ('purchases', 'image_public_id'),
    ('purchases', 'image_provider'),
    ('purchases', 'created_by'),
    ('purchases', 'created_by_name_snapshot'),
    ('purchases', 'created_by_email_snapshot'),
    ('purchases', 'site_name_snapshot'),
    ('purchases', 'updated_by'),
    ('purchases', 'updated_by_name_snapshot'),
    ('purchases', 'created_at'),
    ('purchases', 'updated_at'),
    ('history_events', 'id'),
    ('history_events', 'firebase_id'),
    ('history_events', 'actor_id'),
    ('history_events', 'actor_name_snapshot'),
    ('history_events', 'actor_email_snapshot'),
    ('history_events', 'action'),
    ('history_events', 'site_id'),
    ('history_events', 'site_name_snapshot'),
    ('history_events', 'metadata'),
    ('history_events', 'created_at'),
    ('trash_entries', 'id'),
    ('trash_entries', 'firebase_id'),
    ('trash_entries', 'entity_type'),
    ('trash_entries', 'original_firebase_id'),
    ('trash_entries', 'payload'),
    ('trash_entries', 'deleted_by'),
    ('trash_entries', 'deleted_by_name_snapshot'),
    ('trash_entries', 'deleted_by_email_snapshot'),
    ('trash_entries', 'deleted_at'),
    ('trash_entries', 'expires_at'),
    ('trash_entries', 'restored_at'),
    ('out_deletion_limits', 'profile_id'),
    ('out_deletion_limits', 'limit_date'),
    ('out_deletion_limits', 'deletion_count'),
    ('out_deletion_limits', 'updated_at'),
    ('material_requests', 'id'),
    ('material_requests', 'firebase_id'),
    ('material_requests', 'request_title'),
    ('material_requests', 'requester_id'),
    ('material_requests', 'site_id'),
    ('material_requests', 'status'),
    ('material_requests', 'remark'),
    ('material_requests', 'created_at'),
    ('material_requests', 'updated_at'),
    ('material_request_items', 'id'),
    ('material_request_items', 'request_id'),
    ('material_request_items', 'position'),
    ('material_request_items', 'code'),
    ('material_request_items', 'designation'),
    ('material_request_items', 'quantity'),
    ('material_request_items', 'unit'),
    ('admin_messages', 'id'),
    ('admin_messages', 'firebase_id'),
    ('admin_messages', 'title'),
    ('admin_messages', 'body'),
    ('admin_messages', 'title_template'),
    ('admin_messages', 'body_template'),
    ('admin_messages', 'recipient_mode'),
    ('admin_messages', 'created_by'),
    ('admin_messages', 'created_at'),
    ('message_recipients', 'message_id'),
    ('message_recipients', 'profile_id'),
    ('message_recipients', 'recipient_name_snapshot'),
    ('message_recipients', 'recipient_email_snapshot'),
    ('message_reads', 'message_id'),
    ('message_reads', 'profile_id'),
    ('message_reads', 'read_at'),
    ('message_reads', 'is_synthetic_timestamp')
)
SELECT e.table_name,
       e.column_name,
       COALESCE(c.data_type,
                CASE WHEN c.udt_schema = 'public' THEN c.udt_name END) AS actual_type,
       c.is_nullable AS nullable,
       c.column_default AS "default",
       CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE 'PRESENT' END AS status
FROM expected e
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public'
 AND c.table_name = e.table_name
 AND c.column_name = e.column_name
ORDER BY e.table_name, e.column_name;

-- ==================================================
-- 04. PRIMARY KEYS
-- ==================================================
-- EXPECTED RESULT: composite keys preserve their declared column order.
SELECT c.relname AS table_name,
       con.conname AS constraint_name,
       string_agg(a.attname, ', ' ORDER BY k.ordinality) AS primary_key_columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE n.nspname = 'public' AND con.contype = 'p'
GROUP BY c.relname, con.conname
ORDER BY c.relname;

SELECT t.table_name, 'MISSING_PRIMARY_KEY' AS status
FROM information_schema.tables t
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
  AND t.table_name IN ('profiles','app_settings','material_codes','sites','site_unlock_protections','outs','articles','article_returns','purchases','history_events','trash_entries','out_deletion_limits','material_requests','material_request_items','admin_messages','message_recipients','message_reads')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = format('%I.%I', t.table_schema, t.table_name)::regclass
      AND con.contype = 'p'
  )
ORDER BY t.table_name;

-- ==================================================
-- 05. FOREIGN KEYS
-- ==================================================
-- EXPECTED RESULT: references match 001_schema.sql, including auth.users.
SELECT src.relname AS source_table,
       sa.attname AS source_column,
       tn.nspname || '.' || tgt.relname AS target_table,
       ta.attname AS target_column,
       CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
       CASE con.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
JOIN pg_catalog.pg_namespace sn ON sn.oid = src.relnamespace
JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
JOIN pg_catalog.pg_namespace tn ON tn.oid = tgt.relnamespace
CROSS JOIN LATERAL generate_subscripts(con.conkey, 1) AS pos
JOIN pg_catalog.pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = con.conkey[pos]
JOIN pg_catalog.pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = con.confkey[pos]
WHERE sn.nspname = 'public' AND con.contype = 'f'
ORDER BY source_table, con.conname, pos;

-- ==================================================
-- 06. CASCADE REVIEW
-- ==================================================
-- EXPECTED RESULT: CASCADE is limited to safe child links.
SELECT src.relname AS source_table,
       tgt.relname AS target_table,
       con.conname AS constraint_name,
       CASE WHEN src.relname IN ('sites','outs','articles','purchases')
                 OR tgt.relname IN ('sites','outs','articles','purchases')
            THEN 'REVIEW_REQUIRED' ELSE 'EXPECTED_CHILD_CASCADE' END AS status
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = src.relnamespace
JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
WHERE n.nspname = 'public' AND con.contype = 'f' AND con.confdeltype = 'c'
ORDER BY source_table, target_table;

-- ==================================================
-- 07. UNIQUE
-- ==================================================
-- EXPECTED RESULT: migration identities and normalized business keys are unique.
SELECT c.relname AS table_name,
       con.conname AS constraint_name,
       string_agg(a.attname, ', ' ORDER BY k.ordinality) AS unique_columns
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE n.nspname = 'public' AND con.contype = 'u'
GROUP BY c.relname, con.conname
ORDER BY c.relname, con.conname;

-- ==================================================
-- 08. CHECK
-- ==================================================
-- EXPECTED RESULT: nonnegative quantities/counters/positions, positive returns, ordered trash dates.
SELECT c.relname AS table_name,
       con.conname AS constraint_name,
       pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND con.contype = 'c'
ORDER BY c.relname, con.conname;

-- EXPECTED RESULT: no rows. The preservation table must retain its complete
-- identity, ownership links, uniqueness, and bounded legacy counter contract.
WITH expected(constraint_name, constraint_type) AS (
  VALUES
    ('site_unlock_protections_pkey', 'p'),
    ('site_unlock_protections_site_id_fkey', 'f'),
    ('site_unlock_protections_profile_id_fkey', 'f'),
    ('site_unlock_protections_site_profile_key', 'u'),
    ('site_unlock_protections_attempts_range', 'c')
)
SELECT e.constraint_name, e.constraint_type, 'MISSING_CONSTRAINT' AS status
FROM expected e
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_constraint con
  WHERE con.conrelid = 'public.site_unlock_protections'::regclass
    AND con.conname = e.constraint_name
    AND con.contype = e.constraint_type::"char"
)
ORDER BY e.constraint_name;

-- ==================================================
-- 09. INDEXES
-- ==================================================
SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
FROM pg_catalog.pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- EXPECTED RESULT: no rows (each required leading-column index exists).
WITH required(table_name, column_name) AS (
  VALUES ('sites','unlocked_by'), ('site_unlock_protections','site_id'),
         ('site_unlock_protections','profile_id'), ('outs','site_id'), ('articles','out_id'), ('articles','site_id'),
         ('article_returns','article_id'), ('purchases','site_id'), ('purchases','updated_by'),
         ('history_events','created_at'), ('history_events','site_id'),
         ('trash_entries','expires_at'), ('material_request_items','request_id'),
         ('message_recipients','profile_id'), ('message_reads','profile_id')
)
SELECT r.table_name, r.column_name, 'MISSING_INDEX' AS status
FROM required r
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
  WHERE n.nspname = 'public' AND c.relname = r.table_name
    AND i.indisvalid AND a.attname = r.column_name
)
ORDER BY r.table_name, r.column_name;

-- ==================================================
-- 10. RLS
-- ==================================================
-- EXPECTED RESULT: ENABLED on all 17 tables; disabled is CRITICAL.
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       CASE WHEN c.relrowsecurity THEN 'OK' ELSE 'CRITICAL' END AS status
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  AND c.relname IN ('profiles','app_settings','material_codes','sites','site_unlock_protections','outs','articles','article_returns','purchases','history_events','trash_entries','out_deletion_limits','material_requests','material_request_items','admin_messages','message_recipients','message_reads')
ORDER BY c.relname;

-- ==================================================
-- 11. POLICIES
-- ==================================================
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- Textual heuristic only; every returned policy requires human review.
SELECT schemaname, tablename, policyname, cmd,
       concat_ws(', ',
         CASE WHEN lower(COALESCE(qual,'')) ~ '^\(?true\)?$' THEN 'USING_TRUE' END,
         CASE WHEN lower(COALESCE(with_check,'')) ~ '^\(?true\)?$' THEN 'WITH_CHECK_TRUE' END,
         CASE WHEN lower(COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) LIKE '%email%' THEN 'EMAIL_REFERENCE' END,
         CASE WHEN lower(COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) LIKE '%legacy_role%' THEN 'LEGACY_ROLE_REFERENCE' END,
         CASE WHEN lower(COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) ~ 'username[^=]*=[^=]*admin' THEN 'USERNAME_ADMIN_REFERENCE' END
       ) AS dangerous_pattern,
       'SECURITY_REVIEW_REQUIRED' AS status
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'
  AND (lower(COALESCE(qual,'')) ~ '^\(?true\)?$'
    OR lower(COALESCE(with_check,'')) ~ '^\(?true\)?$'
    OR lower(COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) ~ '(email|legacy_role|username[^=]*=[^=]*admin)')
ORDER BY tablename, policyname;

-- ==================================================
-- 12. MATRICE POLICIES
-- ==================================================
WITH expected(table_name) AS (
  SELECT unnest(ARRAY['profiles','app_settings','material_codes','sites','site_unlock_protections','outs','articles','article_returns','purchases','history_events','trash_entries','out_deletion_limits','material_requests','material_request_items','admin_messages','message_recipients','message_reads']::text[])
)
SELECT e.table_name,
       count(*) FILTER (WHERE p.cmd IN ('SELECT','ALL')) AS select_policy_count,
       count(*) FILTER (WHERE p.cmd IN ('INSERT','ALL')) AS insert_policy_count,
       count(*) FILTER (WHERE p.cmd IN ('UPDATE','ALL')) AS update_policy_count,
       count(*) FILTER (WHERE p.cmd IN ('DELETE','ALL')) AS delete_policy_count,
       CASE WHEN count(p.policyname) = 0 THEN 'NO_POLICY' ELSE 'PRESENT' END AS status
FROM expected e
LEFT JOIN pg_catalog.pg_policies p ON p.schemaname = 'public' AND p.tablename = e.table_name
GROUP BY e.table_name
ORDER BY e.table_name;

-- ==================================================
-- 13. ANON
-- ==================================================
-- EXPECTED RESULT: very limited or no anon access.
SELECT expected.role_name,
       (r.rolname IS NOT NULL) AS exists,
       COALESCE(r.rolcanlogin, false) AS can_login,
       COALESCE(r.rolsuper, false) AS is_superuser
FROM (VALUES ('anon'), ('authenticated'), ('authenticator'), ('service_role')) AS expected(role_name)
LEFT JOIN pg_catalog.pg_roles r ON r.rolname=expected.role_name
ORDER BY expected.role_name;

SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND 'anon' = ANY(roles)
ORDER BY tablename, policyname;

SELECT table_schema, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'anon' AND table_schema = 'public'
ORDER BY table_name, privilege_type;

SELECT (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public' AND 'anon'=ANY(roles)) AS anon_policy_count,
       (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public') AS anon_table_grant_count;

-- ==================================================
-- 14. AUTHENTICATED GRANTS
-- ==================================================
SELECT table_name,
       bool_or(privilege_type = 'SELECT') AS can_select,
       bool_or(privilege_type = 'INSERT') AS can_insert,
       bool_or(privilege_type = 'UPDATE') AS can_update,
       bool_or(privilege_type = 'DELETE') AS can_delete
FROM information_schema.role_table_grants
WHERE grantee = 'authenticated' AND table_schema = 'public'
GROUP BY table_name
ORDER BY table_name;

-- ==================================================
-- 15. COLUMN PRIVILEGES
-- ==================================================
-- EXPECTED RESULT: no freely granted authenticated UPDATE on protected profile columns.
WITH protected(column_name) AS (
  VALUES ('role'),('legacy_role'),('legacy_status'),('legacy_approved'),('legacy_pending'),
         ('firebase_id'),('firebase_uid'),
         ('maintenance_authorized'),('maintenance_access')
)
SELECT p.column_name,
       cp.privilege_type,
       CASE WHEN cp.privilege_type = 'UPDATE' THEN 'PRIVILEGE_REVIEW_REQUIRED' ELSE 'OK' END AS status
FROM protected p
LEFT JOIN information_schema.column_privileges cp
  ON cp.table_schema='public' AND cp.table_name='profiles'
 AND cp.column_name=p.column_name AND cp.grantee='authenticated'
ORDER BY p.column_name, cp.privilege_type;

-- Table-level privileges also apply to every column and must be checked separately.
SELECT table_name, privilege_type, 'PRIVILEGE_REVIEW_REQUIRED' AS status
FROM information_schema.role_table_grants
WHERE grantee='authenticated' AND table_schema='public'
  AND table_name='profiles' AND privilege_type='UPDATE';

-- ==================================================
-- 16. FONCTIONS
-- ==================================================
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_function_result(p.oid) AS return_type,
       p.prosecdef AS security_definer,
       CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility,
       r.rolname AS owner,
       array_to_string(COALESCE(p.proacl, acldefault('f', p.proowner)), ', ') AS execute_privileges
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
WHERE n.nspname='public'
ORDER BY p.proname, identity_arguments;

-- ==================================================
-- 17. SECURITY DEFINER
-- ==================================================
-- EXPECTED RESULT: every definer function has an explicit search_path.
SELECT p.proname AS function_name,
       r.rolname AS owner,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       COALESCE(array_to_string(p.proconfig, ', '), '(not configured)') AS configuration,
       CASE WHEN EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) x WHERE x LIKE 'search_path=%')
            THEN 'OK' ELSE 'CRITICAL' END AS status
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
WHERE n.nspname='public' AND p.prosecdef
ORDER BY p.proname, arguments;

-- ==================================================
-- 18. EXECUTE PUBLIC
-- ==================================================
-- EXPECTED RESULT: business functions do not retain implicit PUBLIC execution.
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       CASE WHEN has_function_privilege('public', p.oid, 'EXECUTE') THEN 'YES' ELSE 'NO' END AS public_execute,
       CASE WHEN has_function_privilege('public', p.oid, 'EXECUTE')
            THEN 'SECURITY_REVIEW_REQUIRED' ELSE 'OK' END AS status
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
ORDER BY p.proname, arguments;

-- ==================================================
-- 19. TRIGGERS
-- ==================================================
SELECT c.relname AS table_name,
       t.tgname AS trigger_name,
       p.proname AS function_name,
       CASE WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE' WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
       concat_ws(', ', CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' END,
                       CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' END,
                       CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' END,
                       CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' END) AS event
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
WHERE n.nspname='public' AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;

-- Textual trigger-function review: no row should mention legacy counters.
SELECT c.relname AS table_name, t.tgname AS trigger_name, p.proname AS function_name,
       'REVIEW_REQUIRED' AS status
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
WHERE n.nspname='public' AND NOT t.tgisinternal
  AND lower(pg_get_functiondef(p.oid)) ~ '(out_count_legacy|article_count_legacy)';

-- ==================================================
-- 20. LEGACY COLUMNS
-- ==================================================
-- EXPECTED RESULT: legacy columns are migration/control fields only.
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND (column_name LIKE '%\_legacy' ESCAPE '\'
       OR (table_name='profiles' AND column_name='legacy_role'))
ORDER BY table_name, ordinal_position;

-- ==================================================
-- 21. FIREBASE IDS
-- ==================================================
-- These source identifiers support reconciliation and idempotence.
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public'
  AND column_name IN ('firebase_id','firebase_uid','firebase_return_id','original_firebase_id')
ORDER BY table_name, column_name;

-- ==================================================
-- 22. ARTICLE SITE CONSISTENCY
-- ==================================================
SELECT count(*) AS total_articles,
       count(*) FILTER (WHERE a.site_id = o.site_id) AS matching_site,
       count(*) FILTER (WHERE a.site_id IS NOT NULL AND a.site_id IS DISTINCT FROM o.site_id) AS different_site,
       count(*) FILTER (WHERE a.site_id IS NULL) AS null_article_site
FROM public.articles a
JOIN public.outs o ON o.id=a.out_id;

-- ==================================================
-- 23. OUT COUNTS
-- ==================================================
WITH actual AS (
  SELECT s.id AS site_id, s.firebase_id, s.out_count_legacy,
         count(o.id) AS relational_count
  FROM public.sites s LEFT JOIN public.outs o ON o.site_id=s.id
  GROUP BY s.id, s.firebase_id, s.out_count_legacy
)
SELECT site_id, firebase_id, out_count_legacy, relational_count,
       relational_count - COALESCE(out_count_legacy,0) AS difference
FROM actual
WHERE out_count_legacy IS DISTINCT FROM relational_count
ORDER BY site_id;

WITH actual AS (
  SELECT s.id, s.out_count_legacy, count(o.id) AS relational_count
  FROM public.sites s LEFT JOIN public.outs o ON o.site_id=s.id
  GROUP BY s.id, s.out_count_legacy
)
SELECT count(*) AS total_sites,
       count(*) FILTER (WHERE out_count_legacy IS DISTINCT FROM relational_count) AS divergent_sites
FROM actual;

-- ==================================================
-- 24. ARTICLE COUNTS
-- ==================================================
WITH actual AS (
  SELECT o.id AS out_id, o.firebase_id, o.article_count_legacy,
         count(a.id) AS relational_count
  FROM public.outs o LEFT JOIN public.articles a ON a.out_id=o.id
  GROUP BY o.id, o.firebase_id, o.article_count_legacy
)
SELECT out_id, firebase_id, article_count_legacy, relational_count,
       relational_count - COALESCE(article_count_legacy,0) AS difference
FROM actual
WHERE article_count_legacy IS DISTINCT FROM relational_count
ORDER BY out_id;

WITH actual AS (
  SELECT o.id, o.article_count_legacy, count(a.id) AS relational_count
  FROM public.outs o LEFT JOIN public.articles a ON a.out_id=o.id
  GROUP BY o.id, o.article_count_legacy
)
SELECT count(*) AS total_outs,
       count(*) FILTER (WHERE article_count_legacy IS DISTINCT FROM relational_count) AS divergent_outs
FROM actual;

-- ==================================================
-- 25. RETURN RECONCILIATION
-- ==================================================
WITH returns AS (
  SELECT article_id, COALESCE(sum(quantity),0) AS relational_quantity
  FROM public.article_returns GROUP BY article_id
)
SELECT a.id AS article_id, a.firebase_id,
       a.quantity_returned_legacy AS legacy_quantity,
       COALESCE(r.relational_quantity,0) AS relational_quantity,
       COALESCE(r.relational_quantity,0) - COALESCE(a.quantity_returned_legacy,0) AS difference
FROM public.articles a
LEFT JOIN returns r ON r.article_id=a.id
WHERE a.quantity_returned_legacy IS DISTINCT FROM COALESCE(r.relational_quantity,0)
ORDER BY a.id;

-- ==================================================
-- 26. RETURN DATE
-- ==================================================
-- EXPECTED RESULT: differences are informational, not automatically business errors.
WITH returns AS (
  SELECT article_id, max(return_date) AS latest_return_date
  FROM public.article_returns GROUP BY article_id
)
SELECT a.id AS article_id, a.firebase_id, a.return_date_legacy,
       r.latest_return_date, 'INFORMATIONAL_REVIEW' AS status
FROM public.articles a
LEFT JOIN returns r ON r.article_id=a.id
WHERE a.return_date_legacy IS DISTINCT FROM r.latest_return_date
ORDER BY a.id;

-- ==================================================
-- 27. ORPHANS
-- ==================================================
-- FK constraints normally prevent many of these; counts also validate imports made with constraints deferred.
SELECT 'out_without_site' AS check_name, count(*) AS issue_count FROM public.outs x LEFT JOIN public.sites p ON p.id=x.site_id WHERE p.id IS NULL
UNION ALL SELECT 'article_without_out', count(*) FROM public.articles x LEFT JOIN public.outs p ON p.id=x.out_id WHERE p.id IS NULL
UNION ALL SELECT 'article_site_differs_from_out', count(*) FROM public.articles x JOIN public.outs p ON p.id=x.out_id WHERE x.site_id IS DISTINCT FROM p.site_id
UNION ALL SELECT 'purchase_without_site', count(*) FROM public.purchases x LEFT JOIN public.sites p ON p.id=x.site_id WHERE p.id IS NULL
UNION ALL SELECT 'return_without_article', count(*) FROM public.article_returns x LEFT JOIN public.articles p ON p.id=x.article_id WHERE p.id IS NULL
UNION ALL SELECT 'request_item_without_request', count(*) FROM public.material_request_items x LEFT JOIN public.material_requests p ON p.id=x.request_id WHERE p.id IS NULL
UNION ALL SELECT 'recipient_without_message', count(*) FROM public.message_recipients x LEFT JOIN public.admin_messages p ON p.id=x.message_id WHERE p.id IS NULL
UNION ALL SELECT 'recipient_without_profile', count(*) FROM public.message_recipients x LEFT JOIN public.profiles p ON p.id=x.profile_id WHERE p.id IS NULL
UNION ALL SELECT 'read_without_message', count(*) FROM public.message_reads x LEFT JOIN public.admin_messages p ON p.id=x.message_id WHERE p.id IS NULL
UNION ALL SELECT 'read_without_profile', count(*) FROM public.message_reads x LEFT JOIN public.profiles p ON p.id=x.profile_id WHERE p.id IS NULL
UNION ALL SELECT 'history_actor_absent', count(*) FROM public.history_events x LEFT JOIN public.profiles p ON p.id=x.actor_id WHERE x.actor_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'history_site_absent', count(*) FROM public.history_events x LEFT JOIN public.sites p ON p.id=x.site_id WHERE x.site_id IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'trash_deleted_by_absent', count(*) FROM public.trash_entries x LEFT JOIN public.profiles p ON p.id=x.deleted_by WHERE x.deleted_by IS NOT NULL AND p.id IS NULL
UNION ALL SELECT 'deletion_limit_profile_absent', count(*) FROM public.out_deletion_limits x LEFT JOIN public.profiles p ON p.id=x.profile_id WHERE p.id IS NULL
ORDER BY check_name;

-- ==================================================
-- 28. DUPLICATES
-- ==================================================
-- Counts expose duplicate groups without printing email, username, or other sensitive values.
SELECT 'profiles.email_citext' AS check_name, count(*) AS duplicate_groups FROM (SELECT lower(email::text) FROM public.profiles WHERE email IS NOT NULL GROUP BY lower(email::text) HAVING count(*)>1) d
UNION ALL SELECT 'profiles.username_citext', count(*) FROM (SELECT lower(username::text) FROM public.profiles WHERE username IS NOT NULL GROUP BY lower(username::text) HAVING count(*)>1) d
UNION ALL SELECT 'profiles.firebase_id', count(*) FROM (SELECT firebase_id FROM public.profiles WHERE firebase_id IS NOT NULL GROUP BY firebase_id HAVING count(*)>1) d
UNION ALL SELECT 'profiles.firebase_uid', count(*) FROM (SELECT firebase_uid FROM public.profiles WHERE firebase_uid IS NOT NULL GROUP BY firebase_uid HAVING count(*)>1) d
UNION ALL SELECT 'sites.firebase_id', count(*) FROM (SELECT firebase_id FROM public.sites WHERE firebase_id IS NOT NULL GROUP BY firebase_id HAVING count(*)>1) d
UNION ALL SELECT 'outs.firebase_id', count(*) FROM (SELECT firebase_id FROM public.outs WHERE firebase_id IS NOT NULL GROUP BY firebase_id HAVING count(*)>1) d
UNION ALL SELECT 'outs.site_normalized_number', count(*) FROM (SELECT site_id, normalized_number FROM public.outs GROUP BY site_id, normalized_number HAVING count(*)>1) d
UNION ALL SELECT 'articles.firebase_id', count(*) FROM (SELECT firebase_id FROM public.articles WHERE firebase_id IS NOT NULL GROUP BY firebase_id HAVING count(*)>1) d
UNION ALL SELECT 'material_codes.firebase_id', count(*) FROM (SELECT firebase_id FROM public.material_codes WHERE firebase_id IS NOT NULL GROUP BY firebase_id HAVING count(*)>1) d
UNION ALL SELECT 'material_codes.normalized_code', count(*) FROM (SELECT normalized_code FROM public.material_codes GROUP BY normalized_code HAVING count(*)>1) d
UNION ALL SELECT 'purchases.site_firebase_id', count(*) FROM (SELECT site_id, firebase_id FROM public.purchases WHERE firebase_id IS NOT NULL GROUP BY site_id, firebase_id HAVING count(*)>1) d
UNION ALL SELECT 'returns.article_firebase_return_id', count(*) FROM (SELECT article_id, firebase_return_id FROM public.article_returns WHERE firebase_return_id IS NOT NULL GROUP BY article_id, firebase_return_id HAVING count(*)>1) d
UNION ALL SELECT 'message_recipient_pair', count(*) FROM (SELECT message_id, profile_id FROM public.message_recipients GROUP BY message_id, profile_id HAVING count(*)>1) d
UNION ALL SELECT 'message_read_pair', count(*) FROM (SELECT message_id, profile_id FROM public.message_reads GROUP BY message_id, profile_id HAVING count(*)>1) d
UNION ALL SELECT 'request_item_position', count(*) FROM (SELECT request_id, position FROM public.material_request_items GROUP BY request_id, position HAVING count(*)>1) d
ORDER BY check_name;

-- ==================================================
-- 29. NULL SOURCE IDS
-- ==================================================
-- EXPECTED RESULT: review NULL source IDs because they weaken import idempotence.
WITH counts(table_name,total_rows,null_source_ids) AS (
  SELECT 'profiles',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.profiles
  UNION ALL SELECT 'material_codes',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.material_codes
  UNION ALL SELECT 'sites',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.sites
  UNION ALL SELECT 'outs',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.outs
  UNION ALL SELECT 'articles',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.articles
  UNION ALL SELECT 'article_returns',count(*),count(*) FILTER (WHERE firebase_return_id IS NULL) FROM public.article_returns
  UNION ALL SELECT 'purchases',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.purchases
  UNION ALL SELECT 'history_events',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.history_events
  UNION ALL SELECT 'trash_entries',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.trash_entries
  UNION ALL SELECT 'material_requests',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.material_requests
  UNION ALL SELECT 'admin_messages',count(*),count(*) FILTER (WHERE firebase_id IS NULL) FROM public.admin_messages
)
SELECT table_name,total_rows,null_source_ids,
       round(100.0*null_source_ids/NULLIF(total_rows,0),2) AS percentage
FROM counts ORDER BY table_name;

-- ==================================================
-- 30. APP SETTINGS
-- ==================================================
-- Values are deliberately not selected.
WITH expected(key) AS (VALUES ('maintenance'),('trash'))
SELECT e.key, (s.key IS NOT NULL) AS exists
FROM expected e LEFT JOIN public.app_settings s ON s.key=e.key
ORDER BY e.key;

-- ==================================================
-- 31. ROLE DISTRIBUTION
-- ==================================================
-- Aggregate-only output: no email or name is exposed.
SELECT role, count(*) AS profile_count
FROM public.profiles GROUP BY role ORDER BY role;

SELECT legacy_role, role, count(*) AS profile_count
FROM public.profiles GROUP BY legacy_role, role ORDER BY legacy_role, role;

-- ==================================================
-- 32. READ_ONLY WRITES REVIEW
-- ==================================================
-- Textual heuristic; returned write policies require manual review, especially profiles and message_reads.
SELECT tablename, policyname, cmd, roles, qual, with_check,
       CASE WHEN tablename IN ('profiles','message_reads') THEN 'PRIORITY_REVIEW' ELSE 'REVIEW' END AS status
FROM pg_catalog.pg_policies
WHERE schemaname='public' AND cmd IN ('INSERT','UPDATE','DELETE','ALL')
  AND (tablename IN ('profiles','message_reads')
       OR lower(COALESCE(qual,'') || ' ' || COALESCE(with_check,'')) ~ '(read_only|current_app_role|can_manage_data)')
ORDER BY tablename, policyname;

-- ==================================================
-- 33. FUNCTIONS VS RLS
-- ==================================================
-- Compare execution exposure with invoker/definer mode for every public RPC candidate.
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'SECURITY INVOKER' END AS security_mode,
       has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
       has_function_privilege('public',p.oid,'EXECUTE') AS public_execute,
       array_to_string(COALESCE(p.proacl, acldefault('f',p.proowner)), ', ') AS execute_grants
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public'
ORDER BY p.proname, arguments;

-- ==================================================
-- 34. SCHEMA VERSION
-- ==================================================
SELECT 'INFORMATIONAL' AS status,
       '001_schema.sql, 002_functions.sql, 003_rls.sql' AS source_files,
       'supabase/schema.sql is legacy and is not a source of truth' AS legacy_schema_note;
