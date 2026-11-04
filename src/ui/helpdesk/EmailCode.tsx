import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { getLocale } from "../../i18n"
import { tr, useT } from "../../i18n/helpdesk"
import { ApiFailure, errorMessage } from "../../lib/api"
import { Button } from "../primitives"
import "../../styles/helpdesk.css"

const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const codeLife = 10 * 60_000
const resendAfter = 60
const maxTries = 5

/** "42 seconds", "5 minutes", "2 hours" in the active language: how long until a rate limit lifts. */
function waitText(seconds: number) {
  const [n, unit] = seconds < 60 ? [seconds, "second"] : seconds < 3600 ? [Math.ceil(seconds / 60), "minute"] : [Math.ceil(seconds / 3600), "hour"]
  return new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: "long" }).format(n)
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

/**
 * Email, then a 6-digit code: one field each, the code paste-friendly (any spaces or dashes are dropped) and sent as
 * soon as six digits are in. Resend waits a minute, or as long as a 429 says. Works inside another form (Enter is
 * handled here, never submitting the outer form). The human check, when the server asks for one, runs on its own.
 */
export function EmailCode<T>({
  id,
  start,
  verify,
  onVerified,
  autoFocus,
  verifyLabel,
  sentTo,
  invalidMessage,
}: {
  /** Prefix for the inputs' ids. */
  id: string
  start: (email: string) => Promise<unknown>
  verify: (email: string, code: string) => Promise<T>
  onVerified: (result: T, email: string) => void | Promise<void>
  autoFocus?: boolean
  /** The code step's button ("Continue" by default). */
  verifyLabel?: string
  /** The line above the code field; defaults to "Enter the 6-digit code we sent to {email}." */
  sentTo?: (email: ReactNode) => ReactNode
  /** What a wrong code says, when the server can't tell (account sign-in answers ok either way). */
  invalidMessage?: string
}) {
  const t = useT()
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const sentAt = useRef(0)
  const wrong = useRef(0)
  const [waitUntil, setWaitUntil] = useState(0)
  const emailInput = useRef<HTMLInputElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)

  const waiting = Math.max(0, Math.ceil((waitUntil - now) / 1000))
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting > 0])

  useEffect(() => {
    if (step === "code") codeInput.current?.focus({ preventScroll: true })
  }, [step])

  const limited = (e: unknown) => {
    if (!(e instanceof ApiFailure) || e.status !== 429) return false
    const seconds = e.retryAfter ?? 0
    if (seconds) setWaitUntil(Date.now() + seconds * 1000)
    setNow(Date.now())
    setError(seconds ? t("error.limit", { time: waitText(seconds) }) : t("error.limitLater"))
    return true
  }

  const send = async (again = false) => {
    const address = email.trim()
    if (!emailShape.test(address)) {
      setError(t("error.invalidEmail"))
      emailInput.current?.focus()
      return
    }
    if (busy || (again && waiting)) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await start(address)
      sentAt.current = Date.now()
      wrong.current = 0
      setWaitUntil(Date.now() + resendAfter * 1000)
      setNow(Date.now())
      setCode("")
      setStep("code")
      if (again) {
        setNote(t("code.resent"))
        codeInput.current?.focus()
      }
    } catch (e) {
      if (!limited(e)) setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const check = async (value = code) => {
    if (busy || value.length !== 6) return
    if (wrong.current >= maxTries) return setError(t("error.tooManyTries"))
    if (Date.now() - sentAt.current > codeLife) return setError(t("error.expired"))
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await verify(email.trim(), value)
      await onVerified(result, email.trim())
    } catch (e) {
      if (limited(e)) return
      if (e instanceof ApiFailure && e.code === "invalid_code") {
        wrong.current++
        setError(
          wrong.current >= maxTries
            ? t("error.tooManyTries")
            : Date.now() - sentAt.current > codeLife
              ? t("error.expired")
              : (invalidMessage ?? t("error.invalidCode")),
        )
        codeInput.current?.select()
      } else setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (action: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    action()
  }

  const message = error ? (
    <p className="code-flow-message field-error" role="alert">
      {error}
    </p>
  ) : (
    <p className="code-flow-message muted-text" aria-live="polite">
      {note ?? (step === "email" ? t("code.emailHint") : (sentTo ?? ((e) => tr("code.sentTo", { email: e })))(<strong className="code-flow-email">{email.trim()}</strong>))}
    </p>
  )

  if (step === "email")
    return (
      <div className="code-flow" role="group">
        <label className="field-label" htmlFor={`${id}-email`}>
          {t("code.email")}
        </label>
        <div className="input" data-size="large" data-invalid={error ? "" : undefined}>
          <input
            ref={emailInput}
            id={`${id}-email`}
            type="email"
            inputMode="email"
            autoComplete="email"
            enterKeyHint="send"
            spellCheck={false}
            autoCapitalize="none"
            placeholder={t("code.emailPlaceholder")}
            value={email}
            autoFocus={autoFocus}
            aria-invalid={!!error}
            onChange={(e) => {
              setEmail(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={onEnter(() => void send())}
          />
        </div>
        <Button variant="primary" size="large" className="btn code-flow-button" onClick={() => void send()} disabled={busy || !!waiting}>
          {busy ? t("code.sending") : t("code.send")}
        </Button>
        {message}
      </div>
    )

  return (
    <div className="code-flow" role="group">
      {/* One line, like the email step's label: the address goes in the message under the button */}
      <label className="field-label" htmlFor={`${id}-code`}>
        {t("code.checkEmail")}
      </label>
      <div className="input code-flow-code" data-size="large" data-invalid={error ? "" : undefined}>
        <input
          ref={codeInput}
          id={`${id}-code`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          enterKeyHint="go"
          pattern="[0-9]*"
          placeholder="000000"
          aria-label={t("code.code")}
          aria-invalid={!!error}
          value={code}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "").slice(0, 6)
            setCode(digits)
            if (error) setError(null)
            if (digits.length === 6) void check(digits)
          }}
          onKeyDown={onEnter(() => void check())}
        />
      </div>
      <Button variant="primary" size="large" className="btn code-flow-button" onClick={() => void check()} disabled={busy || code.length !== 6}>
        {busy ? t("code.verifying") : (verifyLabel ?? t("code.verify"))}
      </Button>
      {message}
      <div className="code-flow-links">
        <button type="button" className="link-button" onClick={() => void send(true)} disabled={busy || !!waiting}>
          {/* Long waits (a rate limit) are explained in the message; a ticking hour helps nobody */}
          {waiting && waiting <= 600 ? t("code.resendIn", { time: clock(waiting) }) : t("code.resend")}
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setStep("email")
            setError(null)
            setNote(null)
            setCode("")
            requestAnimationFrame(() => emailInput.current?.focus())
          }}
          disabled={busy}
        >
          {t("code.changeEmail")}
        </button>
      </div>
    </div>
  )
}
