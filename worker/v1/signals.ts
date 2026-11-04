import type { Actor } from "../../shared/api"
export type Hint = { issue: string; created?: string[]; edited?: string[]; presence?: true; clear?: Actor }
export const contactRoom = (env: Env, app: string, who: string) => env.ROOMS.getByName("enduser:" + app + ":" + who)
// Only IDs cross the mutation boundary. The room never trusts a caller's content snapshot.
export async function signalContact(env: Env, app: string, who: string, hint: Hint) {
  if (who.startsWith("ct_") || who.startsWith("anon_")) await contactRoom(env, app, who).contactChanged(app, who, hint)
}
