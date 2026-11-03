import { useState } from "react"
import type { Actor } from "../../shared/api"
import { AgentAvatar, AiBadge, Avatar } from "./primitives"

export function actorName(actor: Actor) {
  return actor.type === "guest" ? actor.handle : actor.name
}

function Photo({ src, seed, name, size }: { src: string; seed: string; name: string; size: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Avatar seed={seed} name={name} size={size} />
  return (
    <img
      className="avatar"
      data-photo
      src={src}
      width={size}
      height={size}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

export function ActorAvatar({ actor, size = 20 }: { actor: Actor; size?: number }) {
  if (actor.type === "agent") return <AgentAvatar size={size} />
  if (actor.type === "member" && actor.avatar_url) return <Photo src={actor.avatar_url} seed={actor.id} name={actor.name} size={size} />
  return <Avatar seed={actor.id} name={actorName(actor)} size={size} />
}

/** The name, plus the AI badge for agents. */
export function ActorName({ actor, badge = true }: { actor: Actor; badge?: boolean }) {
  return (
    <>
      <strong className="actor-name">{actorName(actor)}</strong>
      {badge && actor.type === "agent" && <AiBadge />}
    </>
  )
}

export function UserAvatar({ user, size = 20 }: { user: { id: string; name?: string | null; email?: string; avatar_url: string | null }; size?: number }) {
  const name = user.name || user.email || "?"
  return user.avatar_url ? (
    <Photo src={user.avatar_url} seed={user.id} name={name} size={size} />
  ) : (
    <Avatar seed={user.id} name={name} size={size} />
  )
}
