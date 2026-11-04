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
    obj({ user: obj({ id: string, email: string, email_verified: bool, name: string, locale }, ["id"]) }),
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
    requested_by: ref("Actor"),
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
  MessageInput: obj({ body: { type: "string", maxLength: 65536 }, attachments: arr(string) }, ["body"]),
  ConversationInput: obj(
    { subject: { type: "string", maxLength: 256 }, message: ref("MessageInput"), metadata_id: string },
    ["message"]
  ),
  Message: obj({
    id: string,
    conversation_id: string,
    author: ref("Participant"),
    body: string,
    attachments: arr(ref("Upload")),
    created_at: date,
    edited_at: nullable(date)
  }),
  Event: one(
    variant("status_changed", { status, close_reason: reason }),
    variant("assigned", { assignee: nullable(ref("Participant")) }),
    variant("verification_requested", { verification_id: string }),
    variant("verified", { verification_id: string })
  ),
  Item: one(
    obj({ kind: { const: "message" }, id: string, created_at: date, message: ref("Message") }),
    obj({
      kind: { const: "event" },
      id: string,
      created_at: date,
      actor: nullable(ref("Participant")),
      event: ref("Event")
    })
  ),
  Conversation: obj({
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
  }),
  Conversations: page("Conversation"),
  Items: page("Item"),
  OpenAPI: obj({ openapi: { const: "3.1.0" }, info: { type: "object" }, paths: { type: "object" } })
}
