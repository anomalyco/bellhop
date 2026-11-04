import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "Abrir chat",
  "launcher.close": "Cerrar chat",
  "launcher.unread": {
    one: "{count} mensaje sin leer",
    many: "{count} mensajes sin leer",
    other: "{count} mensajes sin leer",
  },
  "panel.label": "Chat",
  "panel.close": "Cerrar",
  "panel.back": "Atrás",
  "panel.fallbackTitle": "Soporte",

  // Home
  "home.title": "¿En qué podemos ayudarte?",
  "home.greeting": "Hola, {name}",
  "home.text": "Pregúntanos lo que quieras. Solemos responder en pocos minutos.",
  "home.new": "Nueva conversación",
  "home.recent": "Conversaciones recientes",
  "home.empty": "Aún no hay conversaciones.",
  "home.loading": "Cargando conversaciones…",
  "home.more": "Ver más",

  // Conversation list rows and status
  "status.open": "Abierta",
  "status.in_progress": "En curso",
  "status.waiting": "Esperando tu respuesta",
  "status.closed": "Cerrada",
  "row.unread": { one: "{count} nuevo", many: "{count} nuevos", other: "{count} nuevos" },
  "row.you": "Tú: {text}",
  "row.attachment": "Archivo adjunto",

  // Conversation
  "conversation.new": "Nueva conversación",
  "conversation.you": "Tú",
  "conversation.team": "Equipo",
  "conversation.agent": "IA",
  "conversation.agentLabel": "Asistente de IA",
  "conversation.loading": "Cargando mensajes…",
  "conversation.earlier": "Ver mensajes anteriores",
  "conversation.empty": "Cuéntanos qué necesitas y te responderemos aquí.",
  "conversation.typing": "{name} está escribiendo…",
  "conversation.someone": "Alguien",
  "conversation.edited": "editado",
  "conversation.closedNote": "Esta conversación está cerrada. Escribe para reabrirla.",
  "conversation.attachment": "Archivo adjunto: {name}",

  // Events in the thread
  "event.closed": "Conversación cerrada",
  "event.reopened": "Conversación reabierta",
  "event.in_progress": "Estamos en ello",
  "event.waiting": "Esperando tu respuesta",
  "event.assigned": "{name} se unió a la conversación",
  "event.unassigned": "De vuelta en la cola",
  "event.verificationRequested": "Te pedimos que verificaras un correo",
  "event.verified": "Correo verificado",

  // Composer
  "composer.placeholder": "Escribe un mensaje…",
  "composer.firstPlaceholder": "Describe lo que necesitas…",
  "composer.send": "Enviar",
  "composer.hint": "Enter para enviar, Shift+Enter para una nueva línea",
  "composer.sending": "Enviando…",
  "composer.failed": "No se pudo enviar.",
  "composer.retry": "Reintentar",

  // Verification card (the team asked to confirm an email)
  "verify.title": "Verifica tu correo",
  "verify.text": "Enviamos un código de 6 dígitos a {email}. Introdúcelo aquí para confirmar que es tuyo.",
  "verify.code": "Código",
  "verify.submit": "Verificar",
  "verify.checking": "Comprobando…",
  "verify.done": "{email} está verificado.",
  "verify.wrong": "Ese código no es válido. Revísalo e inténtalo de nuevo.",
  "verify.expired": "Este código ha caducado. Pídenos uno nuevo.",
  "verify.failed": "Demasiados intentos. Pídenos un código nuevo.",

  // Email capture (anonymous or not yet verified)
  "email.title": "¿Cuál es tu correo?",
  "email.text": "Te enviaremos un código para confirmar que eres tú y así poder responderte aquí y por correo.",
  "email.label": "Correo electrónico",
  "email.placeholder": "tu@ejemplo.com",
  "email.continue": "Continuar",
  "email.sending": "Enviando código…",
  "email.codeTitle": "Revisa tu correo",
  "email.codeText": "Introduce el código de 6 dígitos que enviamos a {email}.",
  "email.code": "Código",
  "email.verify": "Verificar",
  "email.verifying": "Verificando…",
  "email.change": "Usar otro correo",
  "email.resend": "Enviar un código nuevo",
  "email.resent": "Código nuevo enviado.",
  "email.invalid": "Introduce un correo electrónico válido.",
  "email.wrongCode": "Ese código no es válido. Revísalo e inténtalo de nuevo.",
  "email.human": "Comprobando que eres una persona…",

  // Connection and errors
  "state.reconnecting": "Reconectando…",
  "state.offline": "Estás sin conexión. Nos pondremos al día cuando vuelvas.",
  "state.ended": "Tu sesión ha terminado. Empieza de nuevo para seguir chateando.",
  "state.restart": "Empezar de nuevo",
  "error.generic": "Algo salió mal. Inténtalo de nuevo.",
  "error.rateLimited": "Demasiadas solicitudes. Inténtalo de nuevo en un momento.",
  "error.unavailable": "El chat no está disponible en este momento.",
}

export default messages
