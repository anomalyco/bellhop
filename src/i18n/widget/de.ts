import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "Chat öffnen",
  "launcher.close": "Chat schließen",
  "launcher.unread": { one: "{count} ungelesene Nachricht", other: "{count} ungelesene Nachrichten" },
  "panel.label": "Chat",
  "panel.close": "Schließen",
  "panel.back": "Zurück",
  "panel.fallbackTitle": "Support",

  // Home
  "home.title": "Wie können wir helfen?",
  "home.greeting": "Hallo {name}",
  "home.text": "Frag uns, was du willst. Wir antworten meist innerhalb weniger Minuten.",
  "home.new": "Neuer Chat",
  "home.recent": "Letzte Chats",
  "home.empty": "Noch keine Chats.",
  "home.loading": "Chats werden geladen…",
  "home.more": "Mehr anzeigen",

  // Conversation list rows and status
  "status.open": "Offen",
  "status.in_progress": "In Bearbeitung",
  "status.waiting": "Wartet auf dich",
  "status.closed": "Geschlossen",
  "row.unread": { one: "{count} neu", other: "{count} neu" },
  "row.you": "Du: {text}",
  "row.attachment": "Anhang",

  // Conversation
  "conversation.new": "Neuer Chat",
  "conversation.you": "Du",
  "conversation.team": "Team",
  "conversation.agent": "KI",
  "conversation.agentLabel": "KI-Assistent",
  "conversation.loading": "Nachrichten werden geladen…",
  "conversation.earlier": "Ältere Nachrichten anzeigen",
  "conversation.empty": "Schreib uns, worum es geht, und wir melden uns hier bei dir.",
  "conversation.typing": "{name} schreibt…",
  "conversation.someone": "Jemand",
  "conversation.edited": "bearbeitet",
  "conversation.closedNote": "Dieser Chat ist geschlossen. Schreib eine Nachricht, um ihn wieder zu öffnen.",
  "conversation.attachment": "Anhang: {name}",

  // Events in the thread
  "event.closed": "Chat geschlossen",
  "event.reopened": "Chat wieder geöffnet",
  "event.in_progress": "Wir kümmern uns darum",
  "event.waiting": "Wartet auf deine Antwort",
  "event.assigned": "{name} ist dem Chat beigetreten",
  "event.unassigned": "Zurück in der Warteschlange",
  "event.verificationRequested": "Wir haben dich gebeten, eine E-Mail-Adresse zu bestätigen",
  "event.verified": "E-Mail-Adresse bestätigt",

  // Composer
  "composer.placeholder": "Nachricht schreiben…",
  "composer.firstPlaceholder": "Beschreib, was du brauchst…",
  "composer.send": "Senden",
  "composer.hint": "Enter zum Senden, Shift+Enter für eine neue Zeile",
  "composer.sending": "Wird gesendet…",
  "composer.failed": "Senden fehlgeschlagen.",
  "composer.retry": "Erneut versuchen",

  // Verification card (the team asked to confirm an email)
  "verify.title": "E-Mail-Adresse bestätigen",
  "verify.text": "Wir haben einen 6-stelligen Code an {email} geschickt. Gib ihn hier ein, um zu bestätigen, dass es deine Adresse ist.",
  "verify.code": "Code",
  "verify.submit": "Bestätigen",
  "verify.checking": "Wird geprüft…",
  "verify.done": "{email} ist bestätigt.",
  "verify.wrong": "Der Code hat nicht funktioniert. Prüf ihn und versuch es noch mal.",
  "verify.expired": "Dieser Code ist abgelaufen. Bitte uns um einen neuen.",
  "verify.failed": "Zu viele Versuche. Bitte uns um einen neuen Code.",

  // Email capture (anonymous or not yet verified)
  "email.title": "Wie lautet deine E-Mail-Adresse?",
  "email.text": "Wir schicken dir einen Code, um zu bestätigen, dass du es bist. So können wir hier und per E-Mail antworten.",
  "email.label": "E-Mail",
  "email.placeholder": "du@beispiel.de",
  "email.continue": "Weiter",
  "email.sending": "Code wird gesendet…",
  "email.codeTitle": "Schau in dein Postfach",
  "email.codeText": "Gib den 6-stelligen Code ein, den wir an {email} geschickt haben.",
  "email.code": "Code",
  "email.verify": "Bestätigen",
  "email.verifying": "Wird bestätigt…",
  "email.change": "Andere E-Mail-Adresse verwenden",
  "email.resend": "Neuen Code senden",
  "email.resent": "Neuer Code gesendet.",
  "email.invalid": "Gib eine gültige E-Mail-Adresse ein.",
  "email.wrongCode": "Der Code hat nicht funktioniert. Prüf ihn und versuch es noch mal.",
  "email.human": "Wir prüfen, ob du ein Mensch bist…",

  // Connection and errors
  "state.reconnecting": "Verbindung wird wiederhergestellt…",
  "state.offline": "Du bist offline. Sobald du wieder online bist, geht's weiter.",
  "state.ended": "Deine Sitzung ist abgelaufen. Starte neu, um weiterzuchatten.",
  "state.restart": "Neu starten",
  "error.generic": "Etwas ist schiefgelaufen. Versuch es noch mal.",
  "error.rateLimited": "Zu viele Anfragen. Versuch es gleich noch mal.",
  "error.unavailable": "Der Chat ist gerade nicht verfügbar.",
}

export default messages
