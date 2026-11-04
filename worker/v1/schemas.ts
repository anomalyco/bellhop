import { LOCALES } from "../../shared/api"

export type Schema = Record<string, unknown>
export const string = { type: "string" },
  integer = { type: "integer" },
  bool = { type: "boolean" },
  date = { type: "string", format: "date-time" },
  locale = { type: "string", enum: LOCALES }
export const nullable = (schema: Schema) => ({ anyOf: [schema, { type: "null" }] }),
  arr = (items: Schema) => ({ type: "array", items }),
  obj = (properties: Record<string, Schema>, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required
  }),
  one = (...schemas: Schema[]) => ({ oneOf: schemas })
const status = { enum: ["open", "in_progress", "waiting", "closed"] },
  reason = nullable({ enum: ["completed", "not_planned", "duplicate"] }),
  ns = nullable(string)
export const ref = (name: string) => ({ $ref: "#/components/schemas/" + name })
const variant = (type: string, fields: Record<string, Schema>) => obj({ type: { const: type }, ...fields })
const page = (item: string) => obj({ data: arr(ref(item)), next_cursor: ns })
export const schemas = {
  Approval: obj({
    id: string,
    issue_number: integer,
    action: string,
    summary: string,
    details: { type: "object", maxProperties: 20, additionalProperties: { type: ["number", "boolean", "string"] } },
    state: { enum: ["pending", "approved", "rejected", "expired", "used"] },
    requested_by: ref("Actor"),
    decided_by: nullable(ref("Actor")),
    decided_at: nullable(date),
    note: ns,
    expires_at: date,
    created_at: date
  }),
  Approvals: arr(ref("Approval")),
  JWKS: obj({
    keys: arr(
      obj({
        kid: string,
        kty: { const: "OKP" },
        crv: { const: "Ed25519" },
        alg: { const: "EdDSA" },
        use: { const: "sig" },
        x: string
      })
    )
  }),
  RequestField: obj(
    {
      key: { type: "string", pattern: "^[a-z0-9_]{1,40}$" },
      label: string,
      kind: { enum: ["text", "textarea", "email", "url", "number", "select"] },
      required: bool,
      options: arr(string),
      help: string,
      verify: bool
    },
    ["key", "label", "kind", "required"]
  ),
  RequestForm: obj({
    id: string,
    name: string,
    description: string,
    fields: arr(ref("RequestField")),
    require_verification: bool
  }),
  Workspace: obj({
    request_types: arr(ref("RequestForm")),
    name: string,
    icon_url: ns,
    allow_anonymous: bool,
    require_verified_email: bool,
    turnstile_site_key: ns,
    brand: obj({ accent: { type: "null" } })
  }),
  Contacts: page("Contact"),
  Contact: { allOf: [ref("EndUser"), obj({ unverified_email: ns, created_at: date, last_seen_at: nullable(date) })] },
  ContactInput: obj({ email: string, email_verified: bool, link_existing: bool, name: string, locale }, []),
  ConversationPatch: obj(
    {
      status,
      close_reason: reason,
      assignee: nullable(one(obj({ member: string }), obj({ agent: string }))),
      labels: arr(string)
    },
    []
  ),
  VerificationInput: obj({ email: string }),
  OK: obj({ ok: { const: true } }),
  Error: obj({ error: obj({ code: string, message: string }) }),
  EndUser: obj({
    id: string,
    name: ns,
    email: nullable({ type: "string", format: "email" }),
    external_id: ns,
    verified_via: { enum: ["host", "email", null] },
    anonymous: bool,
    locale
  }),
  Session: obj({ token: string, expires_at: date, user: ref("EndUser") }),
  SessionInput: one(
    obj({
      user: obj({ id: string, email: string, email_verified: bool, link_existing: bool, name: string, locale }, ["id"])
    }),
    obj({ identity_token: string }),
    obj({ anonymous: { const: true }, turnstile_token: string })
  ),
  EmailStart: obj({ email: string, turnstile_token: string }),
  EmailVerify: obj({ email: string, code: string }),
  Confirm: obj({ code: string }),
  Profile: obj({ name: string, locale }, []),
  Read: obj({ item_id: string }),
  Participant: one(
    variant("user", { id: string, name: ns }),
    variant("team", { id: string, name: string, avatar_url: ns }),
    variant("agent", { id: string, name: string, avatar_url: ns })
  ),
  Actor: one(
    variant("guest", { id: string, handle: string, name: ns }),
    variant("member", { id: string, name: string, avatar_url: ns }),
    variant("agent", { id: string, name: string })
  ),
  Verification: obj({
    id: string,
    email: string,
    state: { enum: ["pending", "verified", "expired", "failed"] },
    requested_by: one(ref("Actor"), variant("team", { id: string, name: string, avatar_url: ns })),
    created_at: date,
    verified_at: nullable(date)
  }),
  Upload: obj({ id: string, name: string, type: string, size: integer, url: string }),
  MultipartFile: obj({ file: { type: "string", format: "binary" } }),
  RealtimeTicket: obj({ url: { type: "string", format: "uri" }, expires_at: date }),
  RealtimeEvent: one(
    variant("item.created", { conversation_id: string, item: ref("Item") }),
    variant("message.updated", { conversation_id: string, message: ref("Message") }),
    variant("conversation.updated", { conversation: ref("Conversation") }),
    variant("typing", { conversation_id: string, participant: ref("Participant") }),
    variant("activity", { conversation_id: string, participant: ref("Participant"), text: ns })
  ),
  MessageInput: obj(
    {
      body: { type: "string", maxLength: 65536 },
      attachments: arr(string),
      internal: bool,
      as: { ...obj({ member: string }), description: "Required with a server key; not available to an end user." }
    },
    ["body"]
  ),
  ConversationInput: obj(
    {
      request_type: string,
      fields: { type: "object", additionalProperties: string },
      subject: { type: "string", maxLength: 256 },
      message: ref("MessageInput"),
      metadata_id: string,
      contact: {
        ...one(obj({ id: string }), obj({ external_id: string })),
        description: "Required with a server key; not available to an end user."
      }
    },
    ["message"]
  ),
  Message: obj(
    {
      held: bool,
      internal: bool,
      id: string,
      conversation_id: string,
      author: ref("Participant"),
      body: string,
      attachments: arr(ref("Upload")),
      created_at: date,
      edited_at: nullable(date)
    },
    ["id", "conversation_id", "author", "body", "attachments", "created_at", "edited_at"]
  ),
  Event: one(
    variant("workspace_event", { action: string, data: { type: "object" } }),
    variant("status_changed", { status, close_reason: reason }),
    variant("assigned", { assignee: nullable(ref("Participant")) }),
    variant("verification_requested", { verification_id: string }),
    variant("verified", { verification_id: string })
  ),
  Item: {
    allOf: [
      obj({ internal: bool, hidden: bool, held: bool }, []),
      one(
        obj({ kind: { const: "message" }, id: string, created_at: date, message: ref("Message") }),
        obj({
          kind: { const: "event" },
          id: string,
          created_at: date,
          actor: nullable(ref("Participant")),
          event: ref("Event")
        })
      )
    ]
  },
  Conversation: obj(
    {
      request_type: nullable(obj({ id: string, name: string })),
      fields: { type: "object", additionalProperties: string },
      effective_autonomy: { enum: ["suggest", "approve_actions", "autonomous"] },
      labels: arr(string),
      contact_id: ns,
      hidden: bool,
      created_via: { const: "api" },
      id: string,
      number: integer,
      subject: string,
      status,
      close_reason: reason,
      created_at: date,
      updated_at: date,
      last_item: nullable(ref("Item")),
      unread: integer,
      assignee: nullable(ref("Participant")),
      verifications: arr(ref("Verification"))
    },
    [
      "id",
      "number",
      "subject",
      "request_type",
      "fields",
      "status",
      "close_reason",
      "created_at",
      "updated_at",
      "last_item",
      "unread",
      "assignee",
      "verifications"
    ]
  ),
  Conversations: page("Conversation"),
  Items: page("Item"),
  OpenAPI: obj({ openapi: { const: "3.1.0" }, info: { type: "object" }, paths: { type: "object" } })
}
