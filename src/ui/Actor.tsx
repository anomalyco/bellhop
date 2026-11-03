import { useState } from "react"
import type { Actor } from "../../shared/api"
import { AgentAvatar, AiBadge, Identicon } from "./primitives"

export function actorName(actor: Actor) {
  return actor.type === "guest" ? actor.handle : actor.name
}

function Photo({ src, seed, size }: { src: string; seed: string; size: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <Identicon seed={seed} size={size} />
  return (
    <img
      className="avatar"
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
  if (actor.type === "member" && actor.avatar_url) return <Photo src={actor.avatar_url} seed={actor.id} size={size} />
  return <Identicon seed={actor.id} size={size} />
}

/** Name in bold, plus the AI badge for agents. */
export function ActorName({ actor, badge = true }: { actor: Actor; badge?: boolean }) {
  return (
    <>
      <strong className="actor-name">{actorName(actor)}</strong>
      {badge && actor.type === "agent" && <AiBadge />}
    </>
  )
}

export function UserAvatar({ user, size = 20 }: { user: { id: string; avatar_url: string | null }; size?: number }) {
  return user.avatar_url ? <Photo src={user.avatar_url} seed={user.id} size={size} /> : <Identicon seed={user.id} size={size} />
}
