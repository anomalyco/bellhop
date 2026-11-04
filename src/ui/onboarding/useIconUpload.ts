import { useState } from "react"
import type { App, AppDetail } from "../../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { setData } from "../../lib/cache"

// The same rules as Settings → General: PNG, JPEG or WebP, up to 1 MB.
export const iconTypes = ["image/png", "image/jpeg", "image/webp"]
const iconLimit = 1024 * 1024
const tooBig = "That image is over 1 MB. Try a smaller export."
const wrongType = "Use a PNG, JPEG or WebP image."

/** Uploads a workspace icon after checking type and size, then updates the cached workspace and list. */
export function useIconUpload(app: AppDetail) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!iconTypes.includes(file.type)) return setError(wrongType)
    if (file.size > iconLimit) return setError(tooBig)
    setBusy(true)
    try {
      const next = await api.putIcon(app.slug, file)
      setData(keys.app(app.slug), next)
      setData<App[]>(keys.apps, (apps) => apps?.map((a) => (a.id === next.id ? { ...a, icon_url: next.icon_url } : a)))
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 413 ? tooBig : e instanceof ApiFailure && e.status === 415 ? wrongType : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return { upload, busy, error }
}
