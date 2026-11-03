import type { Attachment } from "../../shared/api"
import { ApiFailure } from "./api"
import { runHumanCheck } from "./human"

export interface UploadHandle {
  promise: Promise<Attachment>
  abort(): void
}

const limits = { image: 10, video: 100, file: 25 }

export function kindOf(type: string): Attachment["kind"] {
  return type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : "file"
}

/** Raw-body upload over XHR so the composer can show progress. Retries once after a 428 human check. */
export function upload(slug: string, file: File, onProgress: (fraction: number) => void): UploadHandle {
  let xhr: XMLHttpRequest | null = null
  let aborted = false
  const send = (retried: boolean): Promise<Attachment> =>
    new Promise<Attachment>((resolve, reject) => {
      const req = new XMLHttpRequest()
      xhr = req
      req.open("POST", `/api/apps/${encodeURIComponent(slug)}/uploads?name=${encodeURIComponent(file.name)}`)
      req.withCredentials = true
      req.setRequestHeader("Content-Type", file.type || "application/octet-stream")
      req.responseType = "json"
      req.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      req.onload = () => {
        if (req.status >= 200 && req.status < 300) return resolve(req.response as Attachment)
        if (req.status === 428 && !retried && !aborted) {
          runHumanCheck().then(() => send(true).then(resolve, reject), reject)
          return
        }
        const body = req.response as { error?: { code?: string; message?: string } } | null
        const message =
          req.status === 413
            ? `${file.name} is too large (limit ${limits[kindOf(file.type)]} MB).`
            : (body?.error?.message ?? `Upload failed (${req.status}).`)
        reject(new ApiFailure(req.status, body?.error?.code ?? `http_${req.status}`, message))
      }
      req.onerror = () => reject(new Error("Upload failed. Check your connection."))
      req.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"))
      req.send(file)
    })

  const mb = file.size / 1024 / 1024
  const limit = limits[kindOf(file.type)]
  const promise =
    mb > limit ? Promise.reject(new Error(`${file.name} is too large (limit ${limit} MB).`)) : send(false)
  return {
    promise,
    abort() {
      aborted = true
      xhr?.abort()
    },
  }
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
