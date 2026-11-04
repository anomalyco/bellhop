import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react"
import type { Actor } from "../../shared/api"
import { AgentAvatar, AiBadge, Avatar } from "./primitives"
import { useT } from "../i18n/core"

/**
 * Names for help desk contacts who never gave one (email sign-in): their email, for whoever may see it (the team
 * sees the requester's; a requester sees their own). Without it they'd read as "contact-1a2b3c4d".
 */
const ContactNames = createContext<Record<string, string>>({})
export function ContactNamesProvider({ names, children }: { names: Record<string, string>; children: ReactNode }) {
  return <ContactNames.Provider value={names}>{children}</ContactNames.Provider>
}

/** A guest's chosen name, else their handle; everyone else's name. */
export function actorName(actor: Actor) {
  return actor.type === "guest" ? actor.name || actor.handle : actor.name
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

/** A help desk contact posts as a guest-type actor with a "contact-…" handle: a signed-in requester, not a guest. */
export const isContactActor = (actor: Actor) => actor.type === "guest" && !!actor.handle?.startsWith("contact-")

/** The name, then (with `badge`) the AI badge for agents, Owner/Member from the account's role, or a quiet
 *  "Guest" after a named guest. A bare handle already reads as a guest. */
export function ActorName({ actor, badge = true }: { actor: Actor; badge?: boolean }) {
  const t = useT()
  const names = useContext(ContactNames)
  return (
    <>
      <strong className="actor-name">{(isContactActor(actor) && !actor.name && names[actor.id]) || actorName(actor)}</strong>
      {badge && actor.type === "agent" && <AiBadge />}
      {badge && actor.type === "member" && actor.role && <span className="role-badge">{actor.role === "owner" ? t("role.owner") : t("role.member")}</span>}
      {badge && actor.type === "guest" && actor.name && !isContactActor(actor) && <span className="guest-marker">{t("actor.guest")}</span>}
      {badge && actor.type !== "agent" && actor.tier && <TierBadge tier={actor.tier} />}
    </>
  )
}

/** A person's tier (VIP, Pro…): its colour as a dot on a faint tint of it, with the name. Only the team gets tiers. */
export function TierBadge({ tier }: { tier: { name: string; color: string } }) {
  const t = useT()
  return (
    <span className="tier-badge" style={{ "--tier": `#${tier.color}` } as CSSProperties} title={t("actor.tier", { name: tier.name })}>
      <span className="tier-dot" aria-hidden="true" />
      {tier.name}
    </span>
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
