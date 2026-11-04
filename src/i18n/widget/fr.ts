import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "Ouvrir le chat",
  "launcher.close": "Fermer le chat",
  "launcher.unread": {
    one: "{count} message non lu",
    many: "{count} messages non lus",
    other: "{count} messages non lus",
  },
  "panel.label": "Chat",
  "panel.close": "Fermer",
  "panel.back": "Retour",
  "panel.fallbackTitle": "Assistance",

  // Home
  "home.title": "Comment pouvons-nous vous aider ?",
  "home.greeting": "Bonjour {name}",
  "home.text": "Posez-nous vos questions. Nous répondons généralement en quelques minutes.",
  "home.new": "Nouvelle conversation",
  "home.recent": "Conversations récentes",
  "home.empty": "Aucune conversation pour l’instant.",
  "home.loading": "Chargement des conversations…",
  "home.more": "Afficher plus",

  // Conversation list rows and status
  "status.open": "Ouverte",
  "status.in_progress": "En cours",
  "status.waiting": "En attente de votre réponse",
  "status.closed": "Fermée",
  "row.unread": { one: "{count} nouveau", many: "{count} nouveaux", other: "{count} nouveaux" },
  "row.you": "Vous : {text}",
  "row.attachment": "Pièce jointe",

  // Conversation
  "conversation.new": "Nouvelle conversation",
  "conversation.you": "Vous",
  "conversation.team": "Équipe",
  "conversation.agent": "IA",
  "conversation.agentLabel": "Assistant IA",
  "conversation.loading": "Chargement des messages…",
  "conversation.earlier": "Afficher les messages précédents",
  "conversation.empty": "Dites-nous ce dont vous avez besoin, nous vous répondrons ici.",
  "conversation.typing": "{name} écrit…",
  "conversation.someone": "Quelqu’un",
  "conversation.edited": "modifié",
  "conversation.closedNote": "Cette conversation est fermée. Écrivez-nous pour la rouvrir.",
  "conversation.attachment": "Pièce jointe : {name}",

  // Events in the thread
  "event.closed": "Conversation fermée",
  "event.reopened": "Conversation rouverte",
  "event.in_progress": "Nous nous en occupons",
  "event.waiting": "En attente de votre réponse",
  "event.assigned": "{name} a rejoint la conversation",
  "event.unassigned": "De retour dans la file d’attente",
  "event.verificationRequested": "Nous vous avons demandé de vérifier une adresse e-mail",
  "event.verified": "Adresse e-mail vérifiée",

  // Composer
  "composer.placeholder": "Écrivez un message…",
  "composer.firstPlaceholder": "Décrivez votre besoin…",
  "composer.send": "Envoyer",
  "composer.hint": "Entrée pour envoyer, Maj+Entrée pour aller à la ligne",
  "composer.sending": "Envoi…",
  "composer.failed": "Échec de l’envoi.",
  "composer.retry": "Réessayer",

  // Verification card (the team asked to confirm an email)
  "verify.title": "Vérifiez votre adresse e-mail",
  "verify.text": "Nous avons envoyé un code à 6 chiffres à {email}. Saisissez-le ici pour confirmer qu’il s’agit bien de vous.",
  "verify.code": "Code",
  "verify.submit": "Vérifier",
  "verify.checking": "Vérification…",
  "verify.done": "{email} est vérifiée.",
  "verify.wrong": "Ce code ne fonctionne pas. Vérifiez-le et réessayez.",
  "verify.expired": "Ce code a expiré. Demandez-nous-en un nouveau.",
  "verify.failed": "Trop de tentatives. Demandez-nous un nouveau code.",

  // Email capture (anonymous or not yet verified)
  "email.title": "Quelle est votre adresse e-mail ?",
  "email.text": "Nous vous enverrons un code pour confirmer votre identité, afin de vous répondre ici et par e-mail.",
  "email.label": "E-mail",
  "email.placeholder": "vous@exemple.fr",
  "email.continue": "Continuer",
  "email.sending": "Envoi du code…",
  "email.codeTitle": "Consultez vos e-mails",
  "email.codeText": "Saisissez le code à 6 chiffres envoyé à {email}.",
  "email.code": "Code",
  "email.verify": "Vérifier",
  "email.verifying": "Vérification…",
  "email.change": "Utiliser une autre adresse",
  "email.resend": "Envoyer un nouveau code",
  "email.resent": "Nouveau code envoyé.",
  "email.invalid": "Saisissez une adresse e-mail valide.",
  "email.wrongCode": "Ce code ne fonctionne pas. Vérifiez-le et réessayez.",
  "email.human": "Vérification anti-robot…",

  // Connection and errors
  "state.reconnecting": "Reconnexion…",
  "state.offline": "Vous êtes hors ligne. Tout se mettra à jour à votre retour.",
  "state.ended": "Votre session a expiré. Recommencez pour continuer à discuter.",
  "state.restart": "Recommencer",
  "error.generic": "Une erreur est survenue. Réessayez.",
  "error.rateLimited": "Trop de requêtes. Réessayez dans un instant.",
  "error.unavailable": "Le chat est indisponible pour le moment.",

  // Visiteurs d’un site où seuls les clients connectés peuvent discuter ({host} est le site, p. ex. app.example.com)
  "signin.title": "Connectez-vous à {host} pour contacter l’assistance",
  "signin.text": "Le chat est réservé aux clients connectés. Une fois connecté, vous pourrez démarrer une conversation ici.",

  // Messages plus anciens et pièces jointes
  "conversation.older": "Chargement des messages précédents…",
  "composer.attach": "Joindre un fichier",
  "composer.removeFile": "Retirer {name}",
  "upload.uploading": "Envoi de {name}…",
  "upload.tooLarge": "{name} est trop volumineux. Taille maximale : 10 MB pour les images, 100 MB pour les vidéos et 25 MB pour les autres fichiers.",
  "upload.quota": "Vous avez atteint la limite d’envoi de fichiers pour aujourd’hui. Décrivez-le plutôt dans un message, ou réessayez demain.",
  "upload.type": "{name} ne peut pas être envoyé ici. Essayez un autre fichier.",
  "upload.rateLimited": "Trop d’envois au cours de la dernière heure. Réessayez un peu plus tard.",
  "upload.failed": "Impossible d’envoyer {name}. Réessayez.",
}

export default messages
