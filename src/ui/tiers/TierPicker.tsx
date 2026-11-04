import { useState, type CSSProperties } from "react"
import type { Actor, Tier } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { invalidate, useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { actorName } from "../Actor"
import { Button } from "../primitives"
import { AppLink } from "../SiteLink"
import "../../styles/tiers.css"

/** Tiers are for people outside the team: guests and accounts without a role here. Never the team or agents. */
export const canHaveTier = (a: Actor) => a.type === "guest" || (a.type === "member" && !a.role)

/**
 * "Set tier…": a small inline picker of the workspace's tiers plus "No tier" for one person. `onChanged` runs after
 * a change so the page can take the server's view (their tier shows on everything they wrote).
 */
export function TierPicker({ slug, actor, onDone, onChanged }: { slug: string; actor: Actor; onDone: () => void; onChanged: () => void }) {
  const { data: tiers, error } = useResource<Tier[]>(keys.tiers(slug), () => api.tiers(slug), 15_000)
  const current = actor.type !== "agent" ? (actor.tier?.id ?? null) : null
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const choose = async (id: string | null) => {
    if (id === current) return onDone()
    setBusy(id ?? "none")
    setProblem(null)
    try {
      await api.setTier(slug, { actor_id: actor.id }, id)
      invalidate(`people:${slug}:`)
      invalidate(keys.tiers(slug))
      onChanged()
      onDone()
    } catch (e) {
      setProblem(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <div className="tier-picker" role="group" aria-label={`Tier for ${actorName(actor)}`}>
      <span className="tier-picker-label">Tier for {actorName(actor)}</span>
      <div className="tier-picker-options">
        {!tiers && !error && <span className="tier-picker-note">Loading…</span>}
        {tiers?.map((t) => (
          <button
            key={t.id}
            type="button"
            className="tier-option"
            aria-pressed={current === t.id}
            disabled={!!busy}
            style={{ "--tier": `#${t.color}` } as CSSProperties}
            onClick={() => choose(t.id)}
          >
            <span className="tier-dot" aria-hidden="true" />
            {t.name}
          </button>
        ))}
        {!!tiers?.length && (
          <button type="button" className="tier-option" aria-pressed={current === null} disabled={!!busy} onClick={() => choose(null)}>
            No tier
          </button>
        )}
        <Button size="small" variant="invisible" onClick={onDone} disabled={!!busy}>
          Cancel
        </Button>
      </div>
      {tiers?.length === 0 && (
        <p className="tier-picker-note">
          No tiers yet. Create them in{" "}
          <AppLink slug={slug} href={appPath(slug, "/settings/tiers")}>
            Settings → Tiers
          </AppLink>
          .
        </p>
      )}
      {(problem || !!error) && <p className="field-error">{problem ?? errorMessage(error)}</p>}
    </div>
  )
}
