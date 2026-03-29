-- ══════════════════════════════════════════════════════════════════
-- CueDeck — Migration 036: Activity Triggers
-- Auto-log user signup and other key events
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Trigger: Log new user signup ─────────────────────────────────
CREATE OR REPLACE FUNCTION log_user_signup()
RETURNS TRIGGER AS $$
BEGIN
  -- Log the signup event
  INSERT INTO activity_log (user_id, action, category, description, metadata)
  VALUES (
    NEW.id,
    'user_signup',
    'auth',
    'New user registered: ' || COALESCE(NEW.email, 'unknown'),
    jsonb_build_object(
      'name', NEW.name,
      'email', NEW.email,
      'role', NEW.role,
      'invited_by', NEW.invited_by
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_user_signup ON leod_users;
CREATE TRIGGER trg_log_user_signup
  AFTER INSERT ON leod_users
  FOR EACH ROW EXECUTE FUNCTION log_user_signup();

-- ── 2. Trigger: Log role changes ────────────────────────────────────
CREATE OR REPLACE FUNCTION log_role_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    INSERT INTO activity_log (user_id, action, category, description, metadata)
    VALUES (
      NEW.id,
      'role_changed',
      'auth',
      'Role changed from ' || COALESCE(OLD.role, 'none') || ' to ' || NEW.role,
      jsonb_build_object(
        'old_role', OLD.role,
        'new_role', NEW.role,
        'email', NEW.email
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_role_change ON leod_users;
CREATE TRIGGER trg_log_role_change
  AFTER UPDATE ON leod_users
  FOR EACH ROW EXECUTE FUNCTION log_role_change();

-- ── 3. Trigger: Log subscription plan changes ───────────────────────
CREATE OR REPLACE FUNCTION log_plan_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.plan IS DISTINCT FROM NEW.plan THEN
    INSERT INTO activity_log (user_id, action, category, description, metadata)
    VALUES (
      NEW.director_id,
      'plan_changed',
      'billing',
      'Plan changed from ' || COALESCE(OLD.plan, 'none') || ' to ' || NEW.plan,
      jsonb_build_object(
        'old_plan', OLD.plan,
        'new_plan', NEW.plan,
        'old_status', OLD.status,
        'new_status', NEW.status
      )
    );
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO activity_log (user_id, action, category, description, metadata)
    VALUES (
      NEW.director_id,
      'subscription_status_changed',
      'billing',
      'Subscription status changed from ' || COALESCE(OLD.status, 'none') || ' to ' || NEW.status,
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'plan', NEW.plan
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_plan_change ON leod_subscriptions;
CREATE TRIGGER trg_log_plan_change
  AFTER UPDATE ON leod_subscriptions
  FOR EACH ROW EXECUTE FUNCTION log_plan_change();

-- ── 4. Trigger: Log first login ─────────────────────────────────────
CREATE OR REPLACE FUNCTION log_first_login()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.first_login_at IS NULL AND NEW.first_login_at IS NOT NULL THEN
    INSERT INTO activity_log (user_id, action, category, description, metadata)
    VALUES (
      NEW.id,
      'first_login',
      'auth',
      'User completed first login',
      jsonb_build_object(
        'email', NEW.email,
        'name', NEW.name
      )
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_first_login ON leod_users;
CREATE TRIGGER trg_log_first_login
  AFTER UPDATE ON leod_users
  FOR EACH ROW EXECUTE FUNCTION log_first_login();
