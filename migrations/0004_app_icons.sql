-- The R2 key is derived from the app id and version. A new version never reuses an old URL.
ALTER TABLE apps ADD COLUMN icon_version TEXT;
ALTER TABLE apps ADD COLUMN icon_mime TEXT CHECK (
  (icon_version IS NULL) = (icon_mime IS NULL) AND icon_mime IN ('image/png','image/jpeg','image/webp')
);
