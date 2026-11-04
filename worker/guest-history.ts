import type { Actor, App } from "../shared/api"
import { fail, memberActor, now, rows, scopedGuestId, sha256, sql } from "./core"
import type { Ctx, User } from "./core"
import { actorUpdated } from "./events"

// Raw browser IDs and cross-app identifiers are never written to posts. Derive the scoped IDs
// a page at a time. Claims include even empty apps: they can own pending, unattached uploads.
async function* scopes(c: Ctx, user?: User) {
  let after = ""
  for (;;) {
    const apps = await rows<Pick<App, "id" | "role">>(
      sql(
        c.env,
        `SELECT a.id,m.role FROM apps a LEFT JOIN members m ON m.app_id=a.id AND m.user_id=?
       WHERE a.id>? ${user ? "" : "AND a.issue_seq>0"} ORDER BY a.id LIMIT 128`,
        user?.id ?? null,
        after
      )
    )
    if (!apps.length) return
    yield await Promise.all(apps.map(async (a) => ({ ...a, previous: await scopedGuestId(c.var.guestId, a.id) })))
    if (apps.length < 128) return
    after = apps[apps.length - 1]!.id
  }
}

const locations = [
  { table: "issues", col: "author", path: "$", issue: "id" },
  { table: "comments", col: "author", path: "$", issue: "issue_id" },
  { table: "issue_events", col: "actor", path: "$", issue: "issue_id" },
  { table: "issues", col: "activity", path: "$.actor", issue: "id" }
].map((s) => ({
  ...s,
  id: `json_extract(${s.col},'${s.path}.id')`,
  guest: `${s.col === "activity" ? "activity IS NOT NULL AND " : ""}json_extract(${s.col},'${s.path}.type')='guest'`
}))
type RoomHit = { previous_id: string; issue_id: string; app_id: string }
function affectedRooms(env: Env, ids: string, app?: string) {
  return sql(
    env,
    `SELECT hits.*,i.app_id FROM (` +
      locations
        .map(
          (s) => `SELECT ${s.id} previous_id,${s.issue} issue_id FROM ${s.table}
    WHERE ${s.id} IN (SELECT value FROM json_each(?1)) AND ${s.guest}`
        )
        .join(" UNION ") +
      `) hits JOIN issues i ON i.id=hits.issue_id ${app ? "WHERE i.app_id=?2" : ""}`,
    ids,
    ...(app ? [app] : [])
  )
}

export async function renameGuest(c: Ctx, name: string) {
  const statements: D1PreparedStatement[] = [],
    pages: number[] = []
  let populated = 0
  for await (const group of scopes(c)) {
    populated += group.length
    const ids = JSON.stringify(group.map((g) => g.previous))
    pages.push(statements.length)
    statements.push(affectedRooms(c.env, ids))
    for (const s of locations)
      statements.push(
        sql(
          c.env,
          `UPDATE ${s.table} SET ${s.col}=json_set(${s.col},'${s.path}.name',?)
       WHERE ${s.id} IN (SELECT value FROM json_each(?)) AND ${s.guest}`,
          name,
          ids
        )
      )
  }
  // Detect a previously empty app receiving its first issue during discovery; roll back instead
  // of stamping only part of the browser's history. Guest posts retain their own name guard.
  statements.push(
    sql(
      c.env,
      `INSERT INTO guest_names(guest_hash,name,updated_at)
    VALUES(?,CASE WHEN (SELECT count(*) FROM apps WHERE issue_seq>0)=? THEN ? END,?)
    ON CONFLICT(guest_hash) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`,
      c.var.guestHash,
      populated,
      name,
      now()
    )
  )
  const result = await c.env.DB.batch<RoomHit>(statements)
  for (const page of pages) {
    const rooms = new Map<string, { app: string; id: string; issues: string[] }>()
    for (const { previous_id, issue_id, app_id } of result[page]!.results) {
      const key = app_id + ":" + previous_id,
        group = rooms.get(key) ?? { app: app_id, id: previous_id, issues: [] }
      group.issues.push(issue_id)
      rooms.set(key, group)
    }
    for (const { id, issues, app } of rooms.values())
      actorUpdated(c.env, c.executionCtx, app, issues, id, {
        type: "guest",
        id,
        handle: "guest-" + id.slice(0, 4),
        name
      })
  }
}

// Increment in the same transaction as a guest write. Usually no row matches; for an already
// linked browser a new signed-out post/upload makes its next sign-in claim fresh work again.
export const guestWrite = (env: Env, hash: string) =>
  sql(env, "UPDATE guest_links SET generation=generation+1 WHERE guest_hash=?", hash)

async function claimApp(c: Ctx, app: string, previous: string, actor: Actor) {
  const json = JSON.stringify(actor)
  const [hits, ...updates] = await c.env.DB.batch<RoomHit>([
    affectedRooms(c.env, JSON.stringify([previous]), app),
    ...locations.map((s) =>
      sql(
        c.env,
        `UPDATE ${s.table} SET ${s.col}=${
          s.col === "activity" ? "json_set(activity,'$.actor',json(?))" : "?"
        }${s.table === "issues" && s.col === "author" ? ",revision=revision+1" : ""}
      WHERE ${s.id}=? AND ${s.guest} AND ${
        s.table === "issues"
          ? "app_id=?"
          : `EXISTS(SELECT 1 FROM issues i WHERE i.id=${s.table}.issue_id AND i.app_id=?)`
      }`,
        json,
        previous,
        app
      )
    ),
    sql(c.env, "UPDATE attachments SET owner_id=? WHERE app_id=? AND owner_id=?", actor.id, app, previous),
    // Signing in with the same browser must not discard an existing moderation block.
    sql(
      c.env,
      `INSERT OR IGNORE INTO blocks SELECT hex(randomblob(16)),app_id,?,?,moderator,created_at FROM blocks
      WHERE app_id=? AND actor_id=? AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=? AND user_id=?)`,
      actor.id,
      json,
      app,
      previous,
      app,
      actor.id
    )
  ])
  if (updates.some((r) => r.meta.changes)) {
    actorUpdated(
      c.env,
      c.executionCtx,
      app,
      hits!.results.map((h) => h.issue_id),
      previous,
      actor
    )
  }
}

export async function claimGuest(c: Ctx, user: User) {
  const hash = await sha256(c.var.guestId)
  for (let attempt = 0; attempt < 2; attempt++) {
    // Reserve before moving any data; only the original account may finish/retry the link.
    // Failure between apps is resumable; unchanged repeat sign-ins stop at this indexed lookup.
    const generation = await sql(
      c.env,
      `INSERT INTO guest_links(guest_hash,user_id) VALUES(?,?)
      ON CONFLICT(guest_hash) DO UPDATE SET user_id=excluded.user_id
      WHERE guest_links.user_id=excluded.user_id AND generation!=claimed_generation RETURNING generation`,
      hash,
      user.id
    ).first<number>("generation")
    if (generation === null) return
    for await (const group of scopes(c, user)) {
      const present = await rows<{ id: string }>(
        sql(
          c.env,
          `SELECT value id FROM json_each(?) g WHERE EXISTS(SELECT 1 FROM attachments WHERE owner_id=g.value)
         OR ${locations.map((s) => `EXISTS(SELECT 1 FROM ${s.table} WHERE ${s.id}=g.value AND ${s.guest})`).join(" OR ")}`,
          JSON.stringify(group.map((g) => g.previous))
        )
      )
      const ids = new Set(present.map((p) => p.id))
      for (const g of group)
        if (ids.has(g.previous)) {
          await claimApp(c, g.id, g.previous, memberActor(user, g.role))
          const moved = await rows<{ id: string; role: App["role"] }>(
            sql(
              c.env,
              `SELECT DISTINCT i.app_id id,m.role FROM issue_moves mv JOIN issues i ON i.id=mv.issue_id
          LEFT JOIN members m ON m.app_id=i.app_id AND m.user_id=? WHERE mv.from_app=? AND i.app_id!=?`,
              user.id,
              g.id,
              g.id
            )
          )
          for (const t of moved) await claimApp(c, t.id, g.previous, memberActor(user, t.role))
        }
    }
    const merged = await c.env.DB.batch([
      sql(
        c.env,
        "INSERT OR IGNORE INTO issue_votes SELECT issue_id,? FROM issue_votes WHERE voter=?",
        user.id,
        "g:" + hash
      ),
      sql(c.env, "DELETE FROM issue_votes WHERE voter=?", "g:" + hash),
      sql(
        c.env,
        `INSERT OR IGNORE INTO comment_helpful SELECT h.comment_id,? FROM comment_helpful h JOIN comments c ON c.id=h.comment_id WHERE h.voter=? AND json_extract(c.author,'$.id')!=?`,
        user.id,
        "g:" + hash,
        user.id
      ),
      sql(c.env, "DELETE FROM comment_helpful WHERE voter=?", "g:" + hash),
      sql(
        c.env,
        `DELETE FROM comment_helpful WHERE voter=? AND comment_id IN (SELECT id FROM comments WHERE json_extract(author,'$.id')=?)`,
        user.id,
        user.id
      ),
      sql(
        c.env,
        "UPDATE guest_links SET claimed_generation=generation WHERE guest_hash=? AND generation=?",
        hash,
        generation
      )
    ])
    if (merged.at(-1)!.meta.changes) return
  }
  fail(409, "conflict", "Guest posts changed during sign-in; try again")
}
