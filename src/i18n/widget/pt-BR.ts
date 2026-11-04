import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "Abrir chat",
  "launcher.close": "Fechar chat",
  "launcher.unread": {
    one: "{count} mensagem não lida",
    many: "{count} mensagens não lidas",
    other: "{count} mensagens não lidas",
  },
  "panel.label": "Chat",
  "panel.close": "Fechar",
  "panel.back": "Voltar",
  "panel.fallbackTitle": "Suporte",

  // Home
  "home.title": "Como podemos ajudar?",
  "home.greeting": "Olá, {name}",
  "home.text": "Pergunte o que quiser. Costumamos responder em poucos minutos.",
  "home.new": "Nova conversa",
  "home.recent": "Conversas recentes",
  "home.empty": "Nenhuma conversa ainda.",
  "home.loading": "Carregando conversas…",
  "home.more": "Ver mais",

  // Conversation list rows and status
  "status.open": "Aberta",
  "status.in_progress": "Em andamento",
  "status.waiting": "Aguardando você",
  "status.closed": "Encerrada",
  "row.unread": { one: "{count} nova", many: "{count} novas", other: "{count} novas" },
  "row.you": "Você: {text}",
  "row.attachment": "Anexo",

  // Conversation
  "conversation.new": "Nova conversa",
  "conversation.you": "Você",
  "conversation.team": "Equipe",
  "conversation.agent": "IA",
  "conversation.agentLabel": "Assistente de IA",
  "conversation.loading": "Carregando mensagens…",
  "conversation.earlier": "Ver mensagens anteriores",
  "conversation.empty": "Conte o que você precisa e responderemos por aqui.",
  "conversation.typing": "{name} está digitando…",
  "conversation.someone": "Alguém",
  "conversation.edited": "editada",
  "conversation.closedNote": "Esta conversa foi encerrada. Envie uma mensagem para reabri-la.",
  "conversation.attachment": "Anexo: {name}",

  // Events in the thread
  "event.closed": "Conversa encerrada",
  "event.reopened": "Conversa reaberta",
  "event.in_progress": "Estamos cuidando disso",
  "event.waiting": "Aguardando sua resposta",
  "event.assigned": "{name} entrou na conversa",
  "event.unassigned": "De volta à fila",
  "event.verificationRequested": "Pedimos que você confirmasse um e-mail",
  "event.verified": "E-mail confirmado",

  // Composer
  "composer.placeholder": "Escreva uma mensagem…",
  "composer.firstPlaceholder": "Descreva o que você precisa…",
  "composer.send": "Enviar",
  "composer.hint": "Enter para enviar, Shift+Enter para nova linha",
  "composer.sending": "Enviando…",
  "composer.failed": "Não foi possível enviar.",
  "composer.retry": "Tentar de novo",

  // Verification card (the team asked to confirm an email)
  "verify.title": "Confirme seu e-mail",
  "verify.text": "Enviamos um código de 6 dígitos para {email}. Digite-o aqui para confirmar que é seu.",
  "verify.code": "Código",
  "verify.submit": "Confirmar",
  "verify.checking": "Verificando…",
  "verify.done": "{email} foi confirmado.",
  "verify.wrong": "Esse código não funcionou. Confira e tente de novo.",
  "verify.expired": "Este código expirou. Peça um novo para a gente.",
  "verify.failed": "Muitas tentativas. Peça um novo código para a gente.",

  // Email capture (anonymous or not yet verified)
  "email.title": "Qual é o seu e-mail?",
  "email.text": "Vamos enviar um código para confirmar que é você. Assim podemos responder aqui e por e-mail.",
  "email.label": "E-mail",
  "email.placeholder": "voce@exemplo.com",
  "email.continue": "Continuar",
  "email.sending": "Enviando código…",
  "email.codeTitle": "Confira seu e-mail",
  "email.codeText": "Digite o código de 6 dígitos que enviamos para {email}.",
  "email.code": "Código",
  "email.verify": "Confirmar",
  "email.verifying": "Verificando…",
  "email.change": "Usar outro e-mail",
  "email.resend": "Enviar novo código",
  "email.resent": "Novo código enviado.",
  "email.invalid": "Digite um e-mail válido.",
  "email.wrongCode": "Esse código não funcionou. Confira e tente de novo.",
  "email.human": "Verificando se você é humano…",

  // Connection and errors
  "state.reconnecting": "Reconectando…",
  "state.offline": "Você está off-line. Vamos sincronizar quando você voltar.",
  "state.ended": "Sua sessão terminou. Recomece para continuar conversando.",
  "state.restart": "Recomeçar",
  "error.generic": "Algo deu errado. Tente de novo.",
  "error.rateLimited": "Muitas solicitações. Tente de novo daqui a pouco.",
  "error.unavailable": "O chat não está disponível no momento.",
}

export default messages
