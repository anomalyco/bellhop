import { useState } from "react"
import type { App, Invitation, Me } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { invalidate, setData, useResource } from "../../lib/cache"
import { Time } from "../../lib/time"
import { AppIcon, Button } from "../primitives"
import { RoleBadge } from "../roles/RoleSelect"
import "../../styles/features.css"
import { useT } from "../../i18n/core"

/** The account's waiting invitations; null while signed out. A missing route (older backend) reads as none. */
export function useInvitations() {
  const { data: me } = useResource<Me>(keys.me, api.me, 30_000)
  return useResource<Invitation[]>(me?.user ? keys.invitations : null, api.invitations, 30_000)
}

/**
 * Top of /workspaces: invitations waiting for an answer, each with the workspace, the role and who invited you.
 * Accepting puts the workspace in the list below at once; declining just removes the row.
 */
export function InvitationsSection({ invitations }: { invitations: Invitation[] }) {
  const t = useT()
  if (invitations.length === 0) return null
  return (
    <section className="invites" aria-labelledby="invites-title">
      <h2 id="invites-title" className="section-title">
        {t("invite.title", { count: invitations.length })}
      </h2>
      <div className="box">
        {invitations.map((i) => (
          <InvitationRow key={i.id} invitation={i} />
        ))}
      </div>
    </section>
  )
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const t = useT()
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const drop = () => setData<Invitation[]>(keys.invitations, (list) => list?.filter((i) => i.id !== invitation.id))

  const accept = async () => {
    setBusy("accept")
    setError(null)
    try {
      const app = await api.acceptInvitation(invitation.id)
      setData<App[]>(keys.apps, (apps) => (apps ? [...apps.filter((a) => a.id !== app.id), app] : apps))
      invalidate(keys.apps)
      drop()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }
  const decline = async () => {
    setBusy("decline")
    setError(null)
    try {
      await api.declineInvitation(invitation.id)
      drop()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <div className="box-row invite-row">
      <AppIcon src={invitation.app.icon_url} size={28} />
      <div className="app-row-main invite-main">
        <div className="app-row-title">
          <span className="app-row-name">{invitation.app.name}</span>
          <RoleBadge role={invitation.role} />
        </div>
        <div className="issue-meta">
          {t("invite.by", { name: invitation.invited_by.name })} <Time iso={invitation.created_at} />
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      <div className="invite-actions">
        <Button size="small" variant="invisible" onClick={decline} disabled={!!busy}>
          {busy === "decline" ? t("invite.declining") : t("invite.decline")}
        </Button>
        <Button size="small" variant="primary" onClick={accept} disabled={!!busy}>
          {busy === "accept" ? t("invite.accepting") : t("invite.accept")}
        </Button>
      </div>
    </div>
  )
}

/** For the account avatar in the header: a small dot while invitations wait. Renders nothing otherwise. */
export function InvitationDot() {
  const t = useT()
  const { data } = useInvitations()
  const n = data?.length ?? 0
  if (!n) return null
  return <span className="invite-dot" aria-label={t("invite.dot", { count: n })} />
}
