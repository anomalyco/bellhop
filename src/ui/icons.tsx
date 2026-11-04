import type { SVGProps } from "react"

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...props }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const IssueOpenIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
  </Icon>
)

export const IssueProgressIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" stroke="none" />
  </Icon>
)

export const IssueWaitingIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <circle cx="5.25" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="10.75" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
)

export const IssueClosedIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="m5.5 8.25 1.75 1.75 3.25-3.5" />
  </Icon>
)

export const IssueNotPlannedIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="m3.75 12.25 8.5-8.5" />
  </Icon>
)

export const BellIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12.25h11" />
    <path d="M3.75 12.25a4.25 4.25 0 0 1 8.5 0" />
    <path d="M8 6.25v-1.5" />
    <path d="M6.75 3.75h2.5" />
  </Icon>
)

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </Icon>
)

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2" y="2.75" width="12" height="10.5" rx="1.75" />
    <circle cx="5.75" cy="6.25" r="1" />
    <path d="m2.5 11.5 3.25-3 2.5 2.25 2-1.75 3.25 2.75" />
  </Icon>
)

export const VideoIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="3.75" width="9" height="8.5" rx="1.75" />
    <path d="m10.75 6.75 3.5-2v6.5l-3.5-2" />
  </Icon>
)

export const RecordIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" />
    <path d="M5.5 13.75h5M8 11.25v2.5" />
    <circle cx="8" cy="7" r="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m13 7.5-5.25 5.25a3 3 0 0 1-4.25-4.25L9 3a2 2 0 0 1 2.75 2.75L6.5 11a1 1 0 0 1-1.5-1.5l4.75-4.75" />
  </Icon>
)

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.75 9.25a2.75 2.75 0 0 0 4 .25l2-2a2.75 2.75 0 0 0-3.9-3.9l-.85.85" />
    <path d="M9.25 6.75a2.75 2.75 0 0 0-4-.25l-2 2a2.75 2.75 0 0 0 3.9 3.9l.85-.85" />
  </Icon>
)

export const TagIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.25 2.25h5.5l6 6-5.5 5.5-6-6z" />
    <circle cx="5.25" cy="5.25" r="1" fill="currentColor" stroke="none" />
  </Icon>
)

export const CommentIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.25 3.75c0-.83.67-1.5 1.5-1.5h8.5c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H7l-3 2.5v-2.5h-.25c-.83 0-1.5-.67-1.5-1.5z" />
  </Icon>
)

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />
  </Icon>
)

export const ArrowUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
)

export const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.5" />
    <path d="M5.5 7.25V5.5a2.5 2.5 0 0 1 5 0v1.75" />
  </Icon>
)

export const EyeOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 2.75 13.25 13.25" />
    <path d="M6.6 4.1A6.6 6.6 0 0 1 8 4c3.4 0 5.5 4 5.5 4s-.6 1.15-1.75 2.3M10.4 11.4A5.6 5.6 0 0 1 8 12c-3.4 0-5.5-4-5.5-4s.75-1.45 2.2-2.6" />
    <path d="M6.75 6.9a1.75 1.75 0 0 0 2.35 2.35" />
  </Icon>
)

export const BlockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.25" />
    <path d="M4.3 11.7 11.7 4.3" />
  </Icon>
)

export const ThumbIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.25 7.25v6.5H3.25a.5.5 0 0 1-.5-.5v-5.5a.5.5 0 0 1 .5-.5zM5.25 7.25 7.6 2.9a1.15 1.15 0 0 1 2.15.7l-.4 2.65h3.05a1.25 1.25 0 0 1 1.22 1.52l-1 4.5a1.25 1.25 0 0 1-1.22.98H5.25" />
  </Icon>
)

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.75 2.25 13.75 6.25M10.9 3.4 6.6 6.4l-2.35-.3-1 1 5.65 5.65 1-1-.3-2.35 3-4.3M5.6 10.4 2.75 13.25" />
  </Icon>
)

export const SortIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 4.25h10.5M4.75 8h6.5M6.75 11.75h2.5" />
  </Icon>
)

export const XIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
)

export const KebabIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
  </Icon>
)

export const PersonIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="5.25" r="2.75" />
    <path d="M2.75 13.75a5.25 5.25 0 0 1 10.5 0" />
  </Icon>
)

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Icon>
)

export const BookIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.75 3.25c1.9-.5 3.6-.25 5.25.9v8.6c-1.65-1.15-3.35-1.4-5.25-.9zM13.25 3.25c-1.9-.5-3.6-.25-5.25.9v8.6c1.65-1.15 3.35-1.4 5.25-.9z" />
  </Icon>
)

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.25 8.5l3 3 6.5-7" />
  </Icon>
)

export const MailIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5" />
    <path d="M2.25 4.25L8 8.75l5.75-4.5" />
  </Icon>
)

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c1.7 1.75 2.5 3.8 2.5 6.25S9.7 12.5 8 14.25M8 1.75C6.3 3.5 5.5 5.55 5.5 8s.8 4.5 2.5 6.25" />
  </Icon>
)

export const StatusIcon = {
  open: IssueOpenIcon,
  in_progress: IssueProgressIcon,
  waiting: IssueWaitingIcon,
  closed: IssueClosedIcon,
  not_planned: IssueNotPlannedIcon,
} as const
