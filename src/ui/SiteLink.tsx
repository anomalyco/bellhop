import type { AnchorHTMLAttributes } from "react"
import { Link } from "wouter"
import { isAbsolute } from "../lib/site"

/** A client-side link within this host, or a plain anchor when the target is another app's subdomain. */
export function SiteLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return isAbsolute(href) ? <a href={href} {...props} /> : <Link href={href} {...props} />
}
