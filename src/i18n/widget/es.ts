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

  // Visitantes de un sitio donde solo los clientes con sesión iniciada pueden chatear ({host} es el sitio, p. ej. app.example.com)
  "signin.title": "Inicia sesión en {host} para contactar con soporte",
  "signin.text": "El chat está disponible para clientes con sesión iniciada. Cuando hayas iniciado sesión, podrás empezar una conversación aquí.",

  // Mensajes anteriores y archivos adjuntos
  "conversation.older": "Cargando mensajes anteriores…",
  "composer.attach": "Adjuntar un archivo",
  "composer.removeFile": "Quitar {name}",
  "upload.uploading": "Subiendo {name}…",
  "upload.tooLarge": "{name} es demasiado grande. Las imágenes pueden ocupar hasta 10 MB, los vídeos 100 MB y otros archivos 25 MB.",
  "upload.quota": "Has alcanzado el límite de subidas de hoy. Descríbelo en un mensaje o inténtalo de nuevo mañana.",
  "upload.type": "No se puede enviar {name} aquí. Prueba con otro archivo.",
  "upload.rateLimited": "Demasiadas subidas en la última hora. Inténtalo de nuevo un poco más tarde.",
  "upload.failed": "No se pudo subir {name}. Inténtalo de nuevo.",

  // Starting a conversation where the workspace has request types: pick one, then fill in its fields
  "types.title": "¿Con qué necesitas ayuda?",
  "types.other": "Otra cosa",
  "types.otherText": "Cualquier cosa que no encaje arriba.",
  "types.change": "Cambiar",
  "types.changed": "Este formulario acaba de cambiar. Revísalo y vuelve a enviarlo.",
  "field.choose": "Elige…",
  "field.verifyNote": "Te enviaremos un código para confirmarlo.",
  "field.required": "Rellena este campo.",
  "field.email": "Introduce una dirección de correo válida.",
  "field.url": "Introduce un enlace completo que empiece por https://.",
  "field.number": "Introduce un número.",
  "field.option": "Elige una de las opciones.",
  "field.invalid": "Revisa este campo.",

  // Asking for a person instead of the assistant, in an open conversation
  "handoff.action": "Hablar con una persona",
  "handoff.reason": "¿Con qué necesitas ayuda?",
  "handoff.reasonHint": "Opcional",
  "handoff.send": "Pedir una persona",
  "handoff.cancel": "Cancelar",
  "handoff.sending": "Enviando…",
  "handoff.status": "Con el equipo",
  "handoff.already": "Ya pediste hablar con una persona en esta conversación.",
  "event.escalated": "Una persona se encargará a partir de ahora",
}

export default messages
