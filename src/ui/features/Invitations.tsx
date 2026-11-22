import { useState } from "react"
import type { App, Invitation, Me } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { invalidate, setData, useResource } from "../../lib/cache"
import { Time } from "../../lib/time"
import { AppIcon, Button } from "../primitives"
import { RoleBadge } from "../roles/RoleSelect"
import "../../styles/features.css"
import { useT } from "../../i18n/core"
import { useT as useInboxT } from "../../i18n/inbox"

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
  const ti = useInboxT()
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const drop = () => setData<Invitation[]>(keys.invitations, (list) => list?.filter((i) => i.id !== invitation.id))

  const accept = async () => {
    setBusy("accept")
    setError(null)
    try {
      const joined = await api.acceptInvitation(invitation.id)
      // A workspace invitation answers with the app; an org one with the org (its apps come with the next fetch)
      if (invitation.app) setData<App[]>(keys.apps, (apps) => (apps ? [...apps.filter((a) => a.id !== joined.id), joined] : apps))
      invalidate(keys.apps)
      invalidate(keys.orgs)
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

  // Exactly one of app and org is set
  const place = invitation.org ?? invitation.app
  return (
    <div className="box-row invite-row" data-org={invitation.org ? "" : undefined}>
      <AppIcon src={place?.icon_url ?? null} size={28} name={invitation.org ? invitation.org.name : undefined} />
      <div className="app-row-main invite-main">
        <div className="app-row-title">
          <span className="app-row-name">{invitation.org ? ti("invite.joinOrg", { org: invitation.org.name }) : place?.name}</span>
          <RoleBadge role={invitation.role} />
        </div>
        {invitation.org && <div className="issue-meta">{ti("invite.orgText")}</div>}
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
