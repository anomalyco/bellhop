ALTER TABLE approvals ADD COLUMN details_hash TEXT;
ALTER TABLE approvals ADD COLUMN decision_details_hash TEXT;
-- Bind the displayed and signed action to one immutable request, including across a rolling deploy.
CREATE TRIGGER approval_hash_required BEFORE INSERT ON approvals WHEN coalesce(length(NEW.details_hash),0)!=43
 BEGIN SELECT RAISE(ABORT,'approval details hash required'); END;
CREATE TRIGGER approval_details_immutable BEFORE UPDATE OF details,action,details_hash ON approvals
 WHEN NEW.details IS NOT OLD.details OR NEW.action IS NOT OLD.action OR (OLD.details_hash IS NOT NULL AND NEW.details_hash IS NOT OLD.details_hash)
 BEGIN SELECT RAISE(ABORT,'approval details changed'); END;
CREATE TRIGGER approval_decision_attestation BEFORE UPDATE OF state ON approvals
 WHEN NEW.state IN ('approved','rejected','used') AND (NEW.details_hash IS NULL OR NEW.decision_details_hash IS NOT NEW.details_hash)
 BEGIN SELECT RAISE(ABORT,'approval details changed'); END;
DROP VIEW approval_docs;
CREATE VIEW approval_docs AS SELECT p.id,p.issue_id,i.app_id,p.created_at,p.decided_at,p.decided_by,p.requested_by,
 json_object('id',p.id,'issue_number',i.number,'action',p.action,'summary',p.summary,'details',json(p.details),'details_hash',p.details_hash,
 'state',CASE WHEN (p.state IN ('pending','approved') AND p.expires<=unixepoch()) OR (p.state='approved' AND (p.decision_details_hash IS NULL OR p.decision_details_hash IS NOT p.details_hash)) THEN 'expired' ELSE p.state END,
 'requested_by',json(p.requested_by),'decided_by',json(p.decided_by),'decided_at',p.decided_at,'note',p.note,
 'expires_at',strftime('%Y-%m-%dT%H:%M:%fZ',p.expires,'unixepoch'),'created_at',p.created_at) doc
 FROM approvals p JOIN issues i ON i.id=p.issue_id JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk';

CREATE TABLE held_reply_guard(ok INTEGER NOT NULL CONSTRAINT reply_unavailable CHECK(ok=1));
