import type { RequestField, RequestType } from "../../../shared/api"
import { t as td, useT } from "../../i18n/helpdesk"
import { ApiFailure } from "../../lib/api"
import "../../styles/helpdesk.css"

export type Answers = Record<string, string>
export type FieldErrors = Record<string, string>

/** The fields a requester fills in: the type's non-internal ones, in order. */
export const formFields = (type: RequestType | null) => (type?.fields ?? []).filter((f) => !f.internal)

const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const numberShape = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** What's wrong with one answer, if anything (the server checks the same and has the last word). */
function problem(f: RequestField, raw: string | undefined) {
  const v = (raw ?? "").trim()
  if (!v) return f.required ? td("new.errorRequired") : null
  if (f.kind === "email" && !emailShape.test(v)) return td("new.errorEmail")
  if (f.kind === "url" && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(v)) return td("new.errorUrl")
  if (f.kind === "number" && !numberShape.test(v)) return td("new.errorNumber")
  if (f.kind === "select" && !f.options?.includes(v)) return td("new.errorOption")
  return null
}

/** Every field's problem, by key (the requester's fields, or the ones given). */
export function validate(type: RequestType | null, answers: Answers, fields = formFields(type)): FieldErrors {
  const out: FieldErrors = {}
  for (const f of fields) {
    const p = problem(f, answers[f.key])
    if (p) out[f.key] = p
  }
  return out
}

/** The answers that go with the request: this type's fields only, trimmed, empty ones left out. */
export function answersFor(type: RequestType | null, answers: Answers, fields = formFields(type)) {
  const out: Answers = {}
  for (const f of fields) {
    const v = (answers[f.key] ?? "").trim()
    if (v) out[f.key] = v
  }
  return out
}

/** The field a server 400 names ("billing_email: invalid email"), with the message to show under it. */
export function serverFieldError(type: RequestType | null, e: unknown, fields = formFields(type)): FieldErrors | null {
  if (!(e instanceof ApiFailure) || e.status !== 400) return null
  const m = /^([a-z0-9_]+): (.*)$/.exec(e.message)
  const f = m && fields.find((x) => x.key === m[1])
  if (!f) return null
  const why = m![2]!
  const message = /required/.test(why)
    ? td("new.errorRequired")
    : /email/.test(why)
      ? td("new.errorEmail")
      : /URL/i.test(why)
        ? td("new.errorUrl")
        : /number/.test(why)
          ? td("new.errorNumber")
          : /option/.test(why)
            ? td("new.errorOption")
            : td("new.errorField")
  return { [f.key]: message }
}

/**
 * "What do you need help with?": the types as a radio list (name and description), then Something else.
 * `value`: a type's id, null for Something else, undefined while nothing is chosen.
 */
export function TypePicker({ types, value, onChange }: { types: RequestType[]; value: string | null | undefined; onChange: (id: string | null) => void }) {
  const t = useT()
  return (
    <fieldset className="type-picker">
      <legend className="field-label">{t("new.type")}</legend>
      {[...types, null].map((type) => {
        const id = type?.id ?? null
        const on = value === id
        return (
          <label key={id ?? "other"} className="type-option" data-current={on || undefined}>
            <input type="radio" name="request-type" value={id ?? ""} checked={on} onChange={() => onChange(id)} />
            <span className="type-option-text">
              <span className="type-option-name">{type ? type.name : t("new.typeOther")}</span>
              {(type ? type.description : t("new.typeOtherText")) && <span className="type-option-description">{type ? type.description : t("new.typeOtherText")}</span>}
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

/** The chosen type's fields, each with its label, help, and the message for what's wrong with it. */
export function TypeFields({
  type,
  answers,
  errors,
  onChange,
  fields = formFields(type),
  prefix = "request-field",
}: {
  type: RequestType | null
  answers: Answers
  errors: FieldErrors
  onChange: (key: string, value: string) => void
  /** Which fields to ask (default: the requester's); `prefix` keeps ids unique where the form appears twice. */
  fields?: RequestField[]
  prefix?: string
}) {
  const t = useT()
  return (
    <>
      {fields.map((f) => {
        const id = `${prefix}-${f.key}`
        const error = errors[f.key]
        const hints = [f.help, f.kind === "email" && f.verify ? t("new.verifyNote") : null].filter(Boolean)
        const hint = hints.length > 0
        const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined
        const common = {
          id,
          value: answers[f.key] ?? "",
          "aria-invalid": !!error,
          "aria-describedby": described,
          "aria-required": f.required || undefined,
        }
        return (
          <div key={f.key} className="field request-field">
            <label className="field-label" htmlFor={id}>
              {f.label}
              {!f.required && <span className="request-field-optional">{t("new.optional")}</span>}
            </label>
            {f.kind === "textarea" ? (
              <textarea {...common} className="textarea" rows={4} maxLength={8192} onChange={(e) => onChange(f.key, e.target.value)} />
            ) : f.kind === "select" ? (
              <select {...common} className="select" onChange={(e) => onChange(f.key, e.target.value)}>
                <option value="">{t("new.choose")}</option>
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <div className="input" data-invalid={error ? "" : undefined}>
                <input
                  {...common}
                  type={f.kind === "email" ? "email" : f.kind === "url" ? "url" : "text"}
                  inputMode={f.kind === "number" ? "decimal" : f.kind === "email" ? "email" : f.kind === "url" ? "url" : undefined}
                  autoComplete={f.kind === "email" ? "email" : "off"}
                  spellCheck={f.kind === "text" ? undefined : false}
                  maxLength={f.kind === "url" ? 2048 : f.kind === "email" ? 254 : f.kind === "number" ? 64 : 1024}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
              </div>
            )}
            {error ? (
              <p id={`${id}-error`} className="field-error" role="alert">
                {error}
              </p>
            ) : (
              hint && (
                <p id={`${id}-hint`} className="api-hint request-field-hint">
                  {hints.map((h) => (
                    <span key={h}>{h}</span>
                  ))}
                </p>
              )
            )}
          </div>
        )
      })}
    </>
  )
}
