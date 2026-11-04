import { useEffect, useRef, useState } from "react"
import { Button } from "../primitives"
import "../../styles/onboarding.css"

/** Copies `text`; says "Copied" for a moment. `onCopied` runs after a successful copy. */
export function CopyButton({ text, label = "Copy", onCopied }: { text: string; label?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return // Clipboard access denied; the text stays selectable.
    }
    setCopied(true)
    onCopied?.()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Button size="small" onClick={copy} aria-label={copied ? "Copied" : `${label}: ${text}`}>
      <span className="copy-label" data-copied={copied || undefined}>
        <span>{label}</span>
        <span aria-hidden="true">Copied</span>
      </span>
    </Button>
  )
}

/** A command or config snippet with its copy button. */
export function Snippet({ code, label }: { code: string; label?: string }) {
  return (
    <div className="snippet">
      <pre className="snippet-code" aria-label={label}>
        <code>{code}</code>
      </pre>
      <div className="snippet-copy">
        <CopyButton text={code} />
      </div>
    </div>
  )
}

/** A single-line value (a URL) with copy, on one row. */
export function CopyField({ value, onCopied }: { value: string; onCopied?: () => void }) {
  return (
    <div className="copy-field">
      <code className="copy-field-value">{value}</code>
      <CopyButton text={value} onCopied={onCopied} />
    </div>
  )
}
