-- NULL on an account means follow the browser; old posts have no known language.
ALTER TABLE users ADD COLUMN locale TEXT CHECK(locale IN ('en','es','pt-BR','fr','de','ja','zh-CN','ko'));
ALTER TABLE issues ADD COLUMN reporter_locale TEXT CHECK(reporter_locale IN ('en','es','pt-BR','fr','de','ja','zh-CN','ko'));
ALTER TABLE comments ADD COLUMN locale TEXT CHECK(locale IN ('en','es','pt-BR','fr','de','ja','zh-CN','ko'));
ALTER TABLE mail_subs ADD COLUMN locale TEXT CHECK(locale IN ('en','es','pt-BR','fr','de','ja','zh-CN','ko'));

-- Manual opt-ins supply their own locale. For automatic follows, capture the
-- recipient's choice or their own post's locale, never the mentioning sender's.
-- INSERT OR IGNORE on a subsequent post leaves the original snapshot alone.
CREATE TRIGGER mail_subscription_locale AFTER INSERT ON mail_subs WHEN NEW.locale IS NULL BEGIN
 UPDATE mail_subs SET locale=coalesce((SELECT locale FROM users WHERE id=NEW.user_id),
   CASE NEW.reason WHEN 'opened' THEN (SELECT reporter_locale FROM issues WHERE id=NEW.issue_id AND json_extract(author,'$.id')=NEW.actor_id)
   WHEN 'replied' THEN (SELECT c.locale FROM comments c WHERE c.issue_id=NEW.issue_id AND json_extract(c.author,'$.id')=NEW.actor_id ORDER BY c.rowid DESC LIMIT 1) END,
   'en') WHERE id=NEW.id;
END;
