import type { Actor, App } from "../shared/api"
import { fail, memberActor, now, rows, scopedGuestId, sha256, sql } from "./core"
import type { Ctx, User } from "./core"
import { actorUpdated } from "./events"
import { requestLocale } from "./locale"

export async function reportActors(c: Ctx, cookies: string[]) {
  const found = await Promise.all(
    cookies.map(async (cookie) => {
      const hash = await sha256(cookie)
      const [bound, legacy] = await c.env.DB.batch<{ actor_id: string; origin_app: string }>([
        sql(c.env, "SELECT actor_id FROM guest_report_authors WHERE guest_hash=?", hash),
        sql(
          c.env,
          `SELECT DISTINCT origin_app FROM guest_report_authors WHERE guest_hash IS NULL
        AND name IS (SELECT name FROM guest_names WHERE guest_hash=?)`,
          hash
        )
      ])
      const verified = bound!.results.map((r) => r.actor_id)
      // Only origins having *unbound guest reports with this name* are probed. No apps scan.
      for (let i = 0; i < legacy!.results.length; i += 128) {
        const candidates = await Promise.all(
          legacy!.results.slice(i, i + 128).map((r) => scopedGuestId(cookie, r.origin_app))
        )
        const matched = await rows<{ actor_id: string }>(
          sql(
            c.env,
            `SELECT actor_id FROM guest_report_authors WHERE actor_id IN (SELECT value FROM json_each(?)) AND (guest_hash IS NULL OR guest_hash=?)`,
            JSON.stringify(candidates),
            hash
          )
        )
        if (matched.length) {
          const ids = matched.map((r) => r.actor_id)
          verified.push(...ids)
          await sql(
            c.env,
            "UPDATE guest_report_authors SET guest_hash=?,name=NULL WHERE guest_hash IS NULL AND actor_id IN(SELECT value FROM json_each(?))",
            hash,
            JSON.stringify(ids)
          ).run()
        }
      }
      return verified
    })
  )
  return [...new Set([...found.flat(), ...(c.var.user ? [c.var.user.id] : [])])]
}

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
    // Reissue capabilities at the verified account address. A pending guest opt-in is
    // not proof; never turn an old guest reply address into an account credential.
    sql(
      c.env,
      `INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason,locale)
      SELECT s.issue_id,u.id,u.id,u.email,s.state,'manual',s.locale FROM mail_subs s JOIN users u ON u.id=?1 JOIN issues i ON i.id=s.issue_id
      WHERE i.app_id=?2 AND s.actor_id=?3 AND s.address=u.email AND s.state IN ('on','off') AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email)`,
      actor.id,
      app,
      previous
    ),
    sql(
      c.env,
      `INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason,locale)
      SELECT i.id,u.id,u.id,u.email,CASE WHEN gs.state='off' THEN 'off' ELSE 'on' END,
        CASE WHEN json_extract(i.author,'$.id')=?3 THEN 'opened' ELSE 'replied' END,coalesce(gs.locale,u.locale,?4)
      FROM issues i JOIN users u ON u.id=?1 LEFT JOIN mail_settings p ON p.user_id=u.id LEFT JOIN mail_subs gs ON gs.issue_id=i.id AND gs.actor_id=?3
      WHERE i.app_id=?2 AND ((json_extract(i.author,'$.id')=?3 AND coalesce(p.opened,1)) OR (coalesce(p.replied,1) AND i.id IN(SELECT issue_id FROM comments WHERE json_extract(author,'$.id')=?3))) AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email)`,
      actor.id,
      app,
      previous,
      requestLocale(c).locale
    ),
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
    sql(
      c.env,
      "DELETE FROM mail_subs WHERE actor_id=? AND issue_id IN(SELECT id FROM issues WHERE app_id=?)",
      previous,
      app
    ),
    // The account's existing assignment (including one just bound from email) wins.
    sql(
      c.env,
      `INSERT OR IGNORE INTO tier_assignments(app_id,tier_id,actor_id) SELECT app_id,tier_id,?1 FROM tier_assignments
      WHERE app_id=?2 AND actor_id=?3 AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=?2 AND user_id=?1)`,
      actor.id,
      app,
      previous
    ),
    sql(c.env, "DELETE FROM tier_assignments WHERE app_id=? AND actor_id=?", app, previous),
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
         OR EXISTS(SELECT 1 FROM tier_assignments WHERE actor_id=g.value)
         OR EXISTS(SELECT 1 FROM mail_subs WHERE user_id IS NULL AND actor_id=g.value)
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
