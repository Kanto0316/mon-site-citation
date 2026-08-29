-- Phase 4: deny-by-default execution privileges for application functions.
-- Exact identities match 002_functions.sql and 003_rls.sql.
--
-- Function                                                     | Classification  | PUBLIC | anon | authenticated
-- set_updated_at()                                             | TRIGGER ONLY    | DENY   | DENY | DENY
-- normalize_out_number(text)                                   | INTERNAL HELPER | DENY   | DENY | DENY
-- normalize_material_code(text)                                | INTERNAL HELPER | DENY   | DENY | DENY
-- get_article_returned_quantity(uuid)                          | INTERNAL HELPER | DENY   | DENY | ALLOW
-- article_returned_quantity(uuid)                              | INTERNAL HELPER | DENY   | DENY | DENY
-- add_article_return(uuid,numeric,date,text)                    | CLIENT RPC      | DENY   | DENY | ALLOW
-- update_article_return(uuid,numeric,date,text)                 | CLIENT RPC      | DENY   | DENY | ALLOW
-- delete_article_return(uuid)                                  | CLIENT RPC      | DENY   | DENY | ALLOW
-- site_out_count(uuid)                                         | INTERNAL HELPER | DENY   | DENY | DENY
-- out_article_count(uuid)                                      | INTERNAL HELPER | DENY   | DENY | DENY
-- article_site_relation_is_valid(uuid)                         | INTERNAL HELPER | DENY   | DENY | DENY
-- create_trash_entry(text,text,jsonb,uuid,timestamptz,timestamptz) | NOT READY    | DENY   | DENY | DENY
-- mark_trash_entry_restored(uuid)                              | NOT READY       | DENY   | DENY | DENY
-- purge_expired_trash()                                        | SERVER ONLY     | DENY   | DENY | DENY
-- increment_out_deletion_count(uuid,date)                      | NOT READY       | DENY   | DENY | DENY
-- mark_message_read(uuid)                                      | CLIENT RPC      | DENY   | DENY | ALLOW
-- current_app_role()                                           | RLS HELPER      | DENY   | DENY | ALLOW
-- is_admin()                                                   | RLS HELPER      | DENY   | DENY | ALLOW
-- is_privileged_admin()                                        | RLS HELPER      | DENY   | DENY | ALLOW
-- can_manage_data()                                            | RLS HELPER      | DENY   | DENY | ALLOW

-- Revoke first from every browser role so rerunning this migration restores the
-- intended baseline even if a function received an ad-hoc grant after creation.
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_out_number(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.normalize_material_code(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_article_returned_quantity(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.article_returned_quantity(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.add_article_return(uuid, numeric, date, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_article_return(uuid, numeric, date, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_article_return(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.site_out_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.out_article_count(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.article_site_relation_is_valid(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_trash_entry(text, text, jsonb, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_trash_entry_restored(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_expired_trash() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_out_deletion_count(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_message_read(uuid) FROM PUBLIC, anon, authenticated;

-- RLS helpers are SECURITY DEFINER with an empty search_path and derive identity
-- solely from auth.uid(). 003_rls.sql already grants them to authenticated; these
-- idempotent statements make the complete effective policy explicit here.
REVOKE EXECUTE ON FUNCTION public.current_app_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_privileged_admin() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.can_manage_data() FROM PUBLIC, anon, authenticated;

-- Minimal authenticated whitelist. Return mutations are SECURITY INVOKER and remain
-- subject to article/article_returns RLS. Their aggregate helper must be executable
-- by the invoker because add/update call it internally.
GRANT EXECUTE ON FUNCTION public.get_article_returned_quantity(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_article_return(uuid, numeric, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_article_return(uuid, numeric, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_article_return(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_message_read(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_privileged_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_data() TO authenticated;

-- No ALTER DEFAULT PRIVILEGES is issued: the migration runner's owning role is not
-- established by this repository, so changing its defaults could have a wider scope
-- than these application functions. Future function migrations must revoke PUBLIC
-- and anon explicitly, as above.
