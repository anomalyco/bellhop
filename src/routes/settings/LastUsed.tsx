import { Time } from "../../lib/time"
import { t, tr } from "../../i18n/settings"

/** "last used 3 hours ago" or "not used yet". */
export function LastUsed({ iso }: { iso: string | null }) {
  return iso ? <>{tr("lastUsed", { time: <Time iso={iso} /> })}</> : <>{t("notUsed")}</>
}
