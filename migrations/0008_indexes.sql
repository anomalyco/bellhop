CREATE INDEX issues_app_status_number ON issues(app_id,status,number DESC);
CREATE INDEX templates_app_position ON templates(app_id,position);
CREATE INDEX issue_labels_label ON issue_labels(label_id);
-- The (issue_id,comment_id) index groups by comment; issue detail needs insertion order.
CREATE INDEX attachment_links_order ON attachment_links(issue_id);
