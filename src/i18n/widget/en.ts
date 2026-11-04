// The embeddable chat widget, shown to a workspace's end users on the host's site. English is the source of truth for
// keys and {placeholders}; every other locale file covers every key (Translation<typeof en>). White-label: no string
// may name Bellhop. Here a conversation is a chat with the team (not an "issue").

const en = {
  // Launcher and panel
  "launcher.open": "Open chat",
  "launcher.close": "Close chat",
  "launcher.unread": { one: "{count} unread message", other: "{count} unread messages" },
  "panel.label": "Chat",
  "panel.close": "Close",
  "panel.back": "Back",
  "panel.fallbackTitle": "Support",

  // Home
  "home.title": "How can we help?",
  "home.greeting": "Hi {name}",
  "home.text": "Ask us anything. We usually reply within a few minutes.",
  "home.new": "New conversation",
  "home.recent": "Recent conversations",
  "home.empty": "No conversations yet.",
  "home.loading": "Loading conversations…",
  "home.more": "Show more",

  // Conversation list rows and status
  "status.open": "Open",
  "status.in_progress": "In progress",
  "status.waiting": "Waiting for you",
  "status.closed": "Closed",
  "row.unread": { one: "{count} new", other: "{count} new" },
  "row.you": "You: {text}",
  "row.attachment": "Attachment",

  // Conversation
  "conversation.new": "New conversation",
  "conversation.you": "You",
  "conversation.team": "Team",
  "conversation.agent": "AI",
  "conversation.agentLabel": "AI assistant",
  "conversation.loading": "Loading messages…",
  "conversation.earlier": "Show earlier messages",
  "conversation.empty": "Tell us what you need and we'll get back to you here.",
  "conversation.typing": "{name} is typing…",
  "conversation.someone": "Someone",
  "conversation.edited": "edited",
  "conversation.closedNote": "This conversation is closed. Write to reopen it.",
  "conversation.attachment": "Attachment: {name}",

  // Events in the thread
  "event.closed": "Conversation closed",
  "event.reopened": "Conversation reopened",
  "event.in_progress": "We're working on it",
  "event.waiting": "Waiting for your reply",
  "event.assigned": "{name} joined the conversation",
  "event.unassigned": "Back in the queue",
  "event.verificationRequested": "We asked you to verify an email",
  "event.verified": "Email verified",

  // Composer
  "composer.placeholder": "Write a message…",
  "composer.firstPlaceholder": "Describe what you need…",
  "composer.send": "Send",
  "composer.hint": "Enter to send, Shift+Enter for a new line",
  "composer.sending": "Sending…",
  "composer.failed": "Couldn't send.",
  "composer.retry": "Retry",

  // Verification card (the team asked to confirm an email)
  "verify.title": "Verify your email",
  "verify.text": "We sent a 6-digit code to {email}. Enter it here to confirm it's yours.",
  "verify.code": "Code",
  "verify.submit": "Verify",
  "verify.checking": "Checking…",
  "verify.done": "{email} is verified.",
  "verify.wrong": "That code didn't work. Check it and try again.",
  "verify.expired": "This code has expired. Ask us for a new one.",
  "verify.failed": "Too many tries. Ask us for a new code.",

  // Email capture (anonymous or not yet verified)
  "email.title": "What's your email?",
  "email.text": "We'll send a code to confirm it's you, so we can reply here and by email.",
  "email.label": "Email",
  "email.placeholder": "you@example.com",
  "email.continue": "Continue",
  "email.sending": "Sending code…",
  "email.codeTitle": "Check your email",
  "email.codeText": "Enter the 6-digit code we sent to {email}.",
  "email.code": "Code",
  "email.verify": "Verify",
  "email.verifying": "Verifying…",
  "email.change": "Use a different email",
  "email.resend": "Send a new code",
  "email.resent": "New code sent.",
  "email.invalid": "Enter a valid email address.",
  "email.wrongCode": "That code didn't work. Check it and try again.",
  "email.human": "Checking you're human…",

  // Connection and errors
  "state.reconnecting": "Reconnecting…",
  "state.offline": "You're offline. We'll catch up when you're back.",
  "state.ended": "Your session ended. Start again to keep chatting.",
  "state.restart": "Start again",
  "error.generic": "Something went wrong. Try again.",
  "error.rateLimited": "Too many requests. Try again in a moment.",
  "error.unavailable": "Chat is unavailable right now.",
} as const

export default en
