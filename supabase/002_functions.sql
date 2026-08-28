-- Phase 2: generic helpers and transactional business functions.
-- Authorization remains the responsibility of the policies in the future RLS phase.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER app_settings_set_updated_at
BEFORE UPDATE ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER material_codes_set_updated_at
BEFORE UPDATE ON public.material_codes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER sites_set_updated_at
BEFORE UPDATE ON public.sites
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER site_unlock_protections_set_updated_at
BEFORE UPDATE ON public.site_unlock_protections
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER outs_set_updated_at
BEFORE UPDATE ON public.outs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER articles_set_updated_at
BEFORE UPDATE ON public.articles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER purchases_set_updated_at
BEFORE UPDATE ON public.purchases
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER out_deletion_limits_set_updated_at
BEFORE UPDATE ON public.out_deletion_limits
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER material_requests_set_updated_at
BEFORE UPDATE ON public.material_requests
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.normalize_out_number(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT upper(btrim(value));
$$;

CREATE OR REPLACE FUNCTION public.normalize_material_code(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT upper(btrim(value));
$$;

CREATE OR REPLACE FUNCTION public.get_article_returned_quantity(article_uuid UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(sum(ar.quantity), 0::NUMERIC)
  FROM public.article_returns AS ar
  WHERE ar.article_id = article_uuid;
$$;

CREATE OR REPLACE FUNCTION public.article_returned_quantity(article_uuid UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT public.get_article_returned_quantity(article_uuid);
$$;

CREATE OR REPLACE FUNCTION public.add_article_return(
  article_id UUID,
  quantity NUMERIC,
  return_date DATE,
  note TEXT
)
RETURNS public.article_returns
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  target_article public.articles%ROWTYPE;
  created_return public.article_returns%ROWTYPE;
  returned_quantity NUMERIC;
  maximum_returnable NUMERIC;
BEGIN
  IF quantity IS NULL OR quantity <= 0 THEN
    RAISE EXCEPTION 'Return quantity must be greater than zero';
  END IF;

  SELECT * INTO target_article
  FROM public.articles AS a
  WHERE a.id = article_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article not found';
  END IF;

  returned_quantity := public.get_article_returned_quantity(article_id);
  maximum_returnable := GREATEST(
    target_article.quantity_out
      - COALESCE(target_article.quantity_installed, 0)
      - COALESCE(target_article.quantity_scrap, 0),
    0
  );

  -- The Firebase application applies the availability ceiling when quantity_out is positive.
  IF target_article.quantity_out > 0
     AND returned_quantity + quantity > maximum_returnable THEN
    RAISE EXCEPTION 'Return quantity exceeds available quantity';
  END IF;

  INSERT INTO public.article_returns (
    article_id, quantity, return_date, note, created_by
  ) VALUES (
    article_id, quantity, return_date, note, auth.uid()
  )
  RETURNING * INTO created_return;

  RETURN created_return;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_article_return(
  return_id UUID,
  new_quantity NUMERIC,
  new_return_date DATE,
  new_note TEXT
)
RETURNS public.article_returns
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_return public.article_returns%ROWTYPE;
  target_article public.articles%ROWTYPE;
  updated_return public.article_returns%ROWTYPE;
  other_returned_quantity NUMERIC;
  maximum_returnable NUMERIC;
BEGIN
  IF new_quantity IS NULL OR new_quantity <= 0 THEN
    RAISE EXCEPTION 'Return quantity must be greater than zero';
  END IF;

  SELECT * INTO existing_return
  FROM public.article_returns AS ar
  WHERE ar.id = return_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article return not found';
  END IF;

  SELECT * INTO target_article
  FROM public.articles AS a
  WHERE a.id = existing_return.article_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article not found';
  END IF;

  other_returned_quantity :=
    public.get_article_returned_quantity(existing_return.article_id) - existing_return.quantity;
  maximum_returnable := GREATEST(
    target_article.quantity_out
      - COALESCE(target_article.quantity_installed, 0)
      - COALESCE(target_article.quantity_scrap, 0),
    0
  );

  IF target_article.quantity_out > 0
     AND other_returned_quantity + new_quantity > maximum_returnable THEN
    RAISE EXCEPTION 'Return quantity exceeds available quantity';
  END IF;

  UPDATE public.article_returns AS ar
  SET quantity = new_quantity,
      return_date = new_return_date,
      note = new_note
  WHERE ar.id = return_id
  RETURNING * INTO updated_return;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Article return not found';
  END IF;

  RETURN updated_return;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_article_return(return_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_id UUID;
BEGIN
  DELETE FROM public.article_returns AS ar
  WHERE ar.id = return_id
  RETURNING ar.id INTO deleted_id;

  IF deleted_id IS NULL THEN
    RAISE EXCEPTION 'Article return not found';
  END IF;

  RETURN deleted_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.site_out_count(site_uuid UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT count(*) FROM public.outs AS o WHERE o.site_id = site_uuid;
$$;

CREATE OR REPLACE FUNCTION public.out_article_count(out_uuid UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT count(*) FROM public.articles AS a WHERE a.out_id = out_uuid;
$$;

CREATE OR REPLACE FUNCTION public.article_site_relation_is_valid(article_uuid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  -- NULL means the article is absent or its legacy site_id cannot be validated.
  SELECT CASE WHEN a.site_id IS NULL THEN NULL ELSE a.site_id = o.site_id END
  FROM public.articles AS a
  JOIN public.outs AS o ON o.id = a.out_id
  WHERE a.id = article_uuid;
$$;

CREATE OR REPLACE FUNCTION public.create_trash_entry(
  entity_type TEXT,
  original_firebase_id TEXT,
  payload JSONB,
  deleted_by UUID DEFAULT NULL,
  deleted_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS public.trash_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  created_entry public.trash_entries%ROWTYPE;
  effective_deleted_at TIMESTAMPTZ := COALESCE(deleted_at, now());
BEGIN
  IF entity_type IS NULL OR btrim(entity_type) = '' THEN
    RAISE EXCEPTION 'Trash entity type must not be blank';
  END IF;
  IF payload IS NULL THEN
    RAISE EXCEPTION 'Trash payload must not be null';
  END IF;

  INSERT INTO public.trash_entries (
    entity_type, original_firebase_id, payload, deleted_by, deleted_at, expires_at
  ) VALUES (
    entity_type,
    original_firebase_id,
    payload,
    COALESCE(auth.uid(), deleted_by),
    effective_deleted_at,
    COALESCE(expires_at, effective_deleted_at + INTERVAL '24 hours')
  )
  RETURNING * INTO created_entry;

  RETURN created_entry;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_trash_entry_restored(trash_entry_id UUID)
RETURNS public.trash_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  restored_entry public.trash_entries%ROWTYPE;
BEGIN
  UPDATE public.trash_entries AS te
  SET restored_at = COALESCE(te.restored_at, now())
  WHERE te.id = trash_entry_id
  RETURNING * INTO restored_entry;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trash entry not found';
  END IF;

  RETURN restored_entry;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_trash()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM public.trash_entries AS te
    WHERE te.expires_at <= now()
      AND te.restored_at IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_out_deletion_count(
  profile_uuid UUID,
  target_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  IF profile_uuid IS NULL OR target_date IS NULL THEN
    RAISE EXCEPTION 'Profile and target date are required';
  END IF;

  INSERT INTO public.out_deletion_limits AS odl (
    profile_id, limit_date, deletion_count
  ) VALUES (
    profile_uuid, target_date, 1
  )
  ON CONFLICT (profile_id, limit_date) DO UPDATE
  SET deletion_count = odl.deletion_count + 1
  RETURNING deletion_count INTO new_count;

  RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_message_read(message_uuid UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_profile UUID := auth.uid();
BEGIN
  IF current_profile IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  INSERT INTO public.message_reads (message_id, profile_id, read_at)
  VALUES (message_uuid, current_profile, now())
  ON CONFLICT (message_id, profile_id) DO NOTHING;

  RETURN TRUE;
END;
$$;

-- App-setting write helpers are intentionally deferred until the RLS phase defines
-- administrator authorization; exposing one here would provide no safe permission model.
