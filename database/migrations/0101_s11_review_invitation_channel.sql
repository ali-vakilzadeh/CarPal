-- Backend S11: the one preference an inviting business may read (Docs/43.db_setup.sql has the same function).

CREATE OR REPLACE FUNCTION identity.review_invitation_channel(p_user_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p.review_invitation_channel FROM identity.user_preferences p WHERE p.user_id = p_user_id AND p.deleted_at IS NULL
$$;
COMMENT ON FUNCTION identity.review_invitation_channel IS 'The one preference an inviting business needs (52 ReviewRequest); RLS keeps the rest private';
REVOKE ALL ON FUNCTION identity.review_invitation_channel(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.review_invitation_channel(uuid) TO carpal_app_base;
