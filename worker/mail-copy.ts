import type { Locale } from "../shared/api"

export const handoffCopy: Record<
  Locale,
  Record<"assigned" | "passed" | "nobody" | "reminder" | "still_waiting", string>
> = {
  en: {
    assigned: "Support request #{number} needs your reply.",
    passed: "Support request #{number} has passed to another team member.",
    nobody: "Nobody was available to take support request #{number}.",
    reminder: "Support request #{number} is still waiting for your reply.",
    still_waiting: "Support request #{number} is still waiting for a reply from the assigned member."
  },
  es: {
    assigned: "La solicitud de soporte n.º {number} necesita tu respuesta.",
    passed: "La solicitud n.º {number} ha pasado a otra persona del equipo.",
    nobody: "No había nadie disponible para atender la solicitud n.º {number}.",
    reminder: "La solicitud n.º {number} sigue esperando tu respuesta.",
    still_waiting: "La solicitud n.º {number} sigue esperando la respuesta de la persona asignada."
  },
  "pt-BR": {
    assigned: "A solicitação de suporte nº {number} precisa da sua resposta.",
    passed: "A solicitação nº {number} foi encaminhada a outra pessoa da equipe.",
    nobody: "Não havia ninguém disponível para atender à solicitação nº {number}.",
    reminder: "A solicitação nº {number} ainda aguarda sua resposta.",
    still_waiting: "A solicitação nº {number} ainda aguarda uma resposta da pessoa responsável."
  },
  fr: {
    assigned: "La demande d’assistance nº {number} nécessite votre réponse.",
    passed: "La demande nº {number} a été transmise à un autre membre de l’équipe.",
    nobody: "Personne n’était disponible pour traiter la demande nº {number}.",
    reminder: "La demande nº {number} attend toujours votre réponse.",
    still_waiting: "La demande nº {number} attend toujours la réponse du membre chargé du dossier."
  },
  de: {
    assigned: "Supportanfrage Nr. {number} benötigt deine Antwort.",
    passed: "Supportanfrage Nr. {number} wurde an ein anderes Teammitglied weitergegeben.",
    nobody: "Für Supportanfrage Nr. {number} war niemand verfügbar.",
    reminder: "Supportanfrage Nr. {number} wartet weiterhin auf deine Antwort.",
    still_waiting: "Supportanfrage Nr. {number} wartet weiterhin auf eine Antwort des zuständigen Teammitglieds."
  },
  ja: {
    assigned: "サポート依頼 #{number} に返信してください。",
    passed: "サポート依頼 #{number} は別のチームメンバーに引き継がれました。",
    nobody: "サポート依頼 #{number} を担当できるメンバーがいませんでした。",
    reminder: "サポート依頼 #{number} は引き続き返信を待っています。",
    still_waiting: "サポート依頼 #{number} は担当者からの返信を待っています。"
  },
  "zh-CN": {
    assigned: "支持请求 #{number} 需要你回复。",
    passed: "支持请求 #{number} 已转交给其他团队成员。",
    nobody: "转交时无人可以处理支持请求 #{number}。",
    reminder: "支持请求 #{number} 仍在等待你的回复。",
    still_waiting: "支持请求 #{number} 仍在等待负责人的回复。"
  },
  ko: {
    assigned: "지원 요청 #{number}에 답변해 주세요.",
    passed: "지원 요청 #{number}이 다른 팀원에게 전달되었습니다.",
    nobody: "지원 요청 #{number}을 맡을 수 있는 팀원이 없었습니다.",
    reminder: "지원 요청 #{number}이 아직 답변을 기다리고 있습니다.",
    still_waiting: "지원 요청 #{number}이 아직 담당자의 답변을 기다리고 있습니다."
  }
}

export const accountCopy: Record<Locale, { google: string; notice: string }> = {
  en: { google: "This account signs in with Google.", notice: "New sign-in to your account using an email code." },
  es: {
    google: "Esta cuenta inicia sesión con Google.",
    notice: "Se ha iniciado sesión en tu cuenta con un código de correo electrónico."
  },
  "pt-BR": {
    google: "Esta conta usa o Google para entrar.",
    notice: "Um novo acesso à sua conta foi feito com um código por e-mail."
  },
  fr: {
    google: "Ce compte utilise Google pour se connecter.",
    notice: "Nouvelle connexion à votre compte avec un code reçu par e-mail."
  },
  de: {
    google: "Dieses Konto verwendet Google zur Anmeldung.",
    notice: "Neue Anmeldung bei deinem Konto mit einem E-Mail-Code."
  },
  ja: {
    google: "このアカウントには Google でログインします。",
    notice: "メールのコードを使用してアカウントにログインしました。"
  },
  "zh-CN": { google: "此账户使用 Google 登录。", notice: "有人使用电子邮件验证码登录了你的账户。" },
  ko: { google: "이 계정은 Google로 로그인합니다.", notice: "이메일 코드로 계정에 새로 로그인했습니다." }
}

// Machine-translated. The only identity in code mail is the sending workspace.
export const deskCopy: Record<Locale,{signin:string;verify:string;code:string;confirm:string;intro:string}>={
 en:{signin:'Sign in to {workspace}',verify:'Verify your email for {workspace}',code:'Your code for {workspace} is {code}. It expires in 10 minutes. If you did not request it, ignore this email.',confirm:'Confirm email updates from {workspace}',intro:'Confirm that you want updates about your support request.'},
 es:{signin:'Inicia sesión en {workspace}',verify:'Verifica tu correo para {workspace}',code:'Tu código para {workspace} es {code}. Caduca en 10 minutos. Si no lo solicitaste, ignora este correo.',confirm:'Confirma las notificaciones de {workspace}',intro:'Confirma que quieres recibir novedades sobre tu solicitud.'},
 'pt-BR':{signin:'Entre em {workspace}',verify:'Verifique seu e-mail para {workspace}',code:'Seu código para {workspace} é {code}. Ele expira em 10 minutos. Se você não o solicitou, ignore este e-mail.',confirm:'Confirme as notificações de {workspace}',intro:'Confirme que deseja receber atualizações sobre sua solicitação.'},
 fr:{signin:'Connexion à {workspace}',verify:'Vérifiez votre adresse pour {workspace}',code:'Votre code pour {workspace} est {code}. Il expire dans 10 minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.',confirm:'Confirmez les notifications de {workspace}',intro:'Confirmez que vous souhaitez recevoir les mises à jour de votre demande.'},
 de:{signin:'Bei {workspace} anmelden',verify:'E-Mail-Adresse für {workspace} bestätigen',code:'Dein Code für {workspace} lautet {code}. Er ist 10 Minuten gültig. Wenn du ihn nicht angefordert hast, ignoriere diese E-Mail.',confirm:'Benachrichtigungen von {workspace} bestätigen',intro:'Bestätige, dass du Updates zu deiner Anfrage erhalten möchtest.'},
 ja:{signin:'{workspace}にログイン',verify:'{workspace}のメールアドレス確認',code:'{workspace}の確認コードは {code} です。有効期限は10分です。心当たりがない場合は、このメールを無視してください。',confirm:'{workspace}の通知登録をご確認ください',intro:'お問い合わせの更新通知を受け取るには、登録を確認してください。'},
 'zh-CN':{signin:'登录 {workspace}',verify:'为 {workspace} 验证邮箱',code:'你在 {workspace} 的验证码是 {code}，10 分钟内有效。如非本人请求，请忽略此邮件。',confirm:'确认订阅 {workspace} 的通知',intro:'请确认你希望收到此请求的更新。'},
 ko:{signin:'{workspace} 로그인',verify:'{workspace} 이메일 주소 확인',code:'{workspace} 인증 코드는 {code}입니다. 10분간 유효합니다. 직접 요청하지 않았다면 이 메일을 무시하세요.',confirm:'{workspace} 알림 구독 확인',intro:'문의에 대한 업데이트를 받으려면 구독을 확인하세요.'}
}

// Machine-translated fixed email copy; issue titles, workspace names, authors and
// message bodies are interpolated as-is, never sent to a translation service.
const en = {
  sender: "{app} via Bellhop",
  subject: "Re: {title} (#{number} · {app})",
  confirmSubject: "Confirm your Bellhop subscription",
  confirmIntro: "Confirm that you want email updates on a Bellhop issue.",
  confirmAction: "Confirm subscription",
  ignore: "If you didn’t request this, you can ignore this email.",
  unsubscribe: "Unsubscribe from this issue",
  stop: "Stop all Bellhop email",
  view: "View issue #{number}",
  answer: "Reply to this email to answer.",
  noteAnswer: "Reply to this email to leave an internal note.",
  nudge: "The team is waiting for your reply on this issue.",
  assigned: "Assigned to you",
  mentioned: "You were mentioned in the issue",
  reply: "Reply",
  mention: "Mention",
  by: "{label} from {author}",
  note: "internal note",
  attachment: "(attachment)",
  status: "Status: {status}",
  statuses: { open: "Open", in_progress: "In progress", waiting: "Waiting", closed: "Closed" }
}
export const mailCopy: Record<Locale, typeof en> = {
  en,
  es: {
    sender: "{app} a través de Bellhop",
    subject: "Re: {title} (n.º {number} · {app})",
    confirmSubject: "Confirma tu suscripción a Bellhop",
    confirmIntro: "Confirma que quieres recibir novedades por correo sobre una incidencia en Bellhop.",
    confirmAction: "Confirmar suscripción",
    ignore: "Si no lo solicitaste, puedes ignorar este correo.",
    unsubscribe: "Dejar de seguir esta incidencia",
    stop: "Dejar de recibir correos de Bellhop",
    view: "Ver incidencia n.º {number}",
    answer: "Responde a este correo para contestar.",
    noteAnswer: "Responde a este correo para dejar una nota interna.",
    nudge: "El equipo está esperando tu respuesta en esta incidencia.",
    assigned: "Se te ha asignado esta incidencia",
    mentioned: "Te han mencionado en la incidencia",
    reply: "Respuesta",
    mention: "Mención",
    by: "{label} de {author}",
    note: "nota interna",
    attachment: "(archivo adjunto)",
    status: "Estado: {status}",
    statuses: { open: "Abierta", in_progress: "En curso", waiting: "En espera", closed: "Cerrada" }
  },
  "pt-BR": {
    sender: "{app} via Bellhop",
    subject: "Re: {title} (nº {number} · {app})",
    confirmSubject: "Confirme sua inscrição no Bellhop",
    confirmIntro: "Confirme que deseja receber atualizações por e-mail sobre um chamado no Bellhop.",
    confirmAction: "Confirmar inscrição",
    ignore: "Se você não fez essa solicitação, ignore este e-mail.",
    unsubscribe: "Deixar de seguir este chamado",
    stop: "Parar de receber e-mails do Bellhop",
    view: "Ver chamado nº {number}",
    answer: "Responda a este e-mail para enviar sua resposta.",
    noteAnswer: "Responda a este e-mail para deixar uma nota interna.",
    nudge: "A equipe está aguardando sua resposta neste chamado.",
    assigned: "Este chamado foi atribuído a você",
    mentioned: "Você recebeu uma menção no chamado",
    reply: "Resposta",
    mention: "Menção",
    by: "{label} de {author}",
    note: "nota interna",
    attachment: "(anexo)",
    status: "Status: {status}",
    statuses: { open: "Aberto", in_progress: "Em andamento", waiting: "Aguardando", closed: "Fechado" }
  },
  fr: {
    sender: "{app} via Bellhop",
    subject: "Re : {title} (n° {number} · {app})",
    confirmSubject: "Confirmez votre abonnement à Bellhop",
    confirmIntro: "Confirmez que vous souhaitez recevoir par e-mail les mises à jour d’un ticket Bellhop.",
    confirmAction: "Confirmer l’abonnement",
    ignore: "Si vous n’êtes pas à l’origine de cette demande, ignorez cet e-mail.",
    unsubscribe: "Ne plus suivre ce ticket",
    stop: "Ne plus recevoir d’e-mails de Bellhop",
    view: "Voir le ticket n° {number}",
    answer: "Pour répondre, répondez à cet e-mail.",
    noteAnswer: "Répondez à cet e-mail pour ajouter une note interne.",
    nudge: "L’équipe attend votre réponse sur ce ticket.",
    assigned: "Ce ticket vous a été attribué",
    mentioned: "Vous avez été mentionné dans le ticket",
    reply: "Réponse",
    mention: "Mention",
    by: "{label} de {author}",
    note: "note interne",
    attachment: "(pièce jointe)",
    status: "Statut : {status}",
    statuses: { open: "Ouvert", in_progress: "En cours", waiting: "En attente", closed: "Fermé" }
  },
  de: {
    sender: "{app} über Bellhop",
    subject: "AW: {title} (Nr. {number} · {app})",
    confirmSubject: "Bestätige dein Bellhop-Abonnement",
    confirmIntro: "Bestätige, dass du per E-Mail über ein Bellhop-Ticket informiert werden möchtest.",
    confirmAction: "Abonnement bestätigen",
    ignore: "Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.",
    unsubscribe: "Diesem Ticket nicht mehr folgen",
    stop: "Alle E-Mails von Bellhop abbestellen",
    view: "Ticket Nr. {number} ansehen",
    answer: "Antworte direkt auf diese E-Mail.",
    noteAnswer: "Antworte auf diese E-Mail, um eine interne Notiz zu hinterlassen.",
    nudge: "Das Team wartet bei diesem Ticket auf deine Antwort.",
    assigned: "Dieses Ticket wurde dir zugewiesen",
    mentioned: "Du wurdest im Ticket erwähnt",
    reply: "Antwort",
    mention: "Erwähnung",
    by: "{label} von {author}",
    note: "interne Notiz",
    attachment: "(Anhang)",
    status: "Status: {status}",
    statuses: { open: "Offen", in_progress: "In Bearbeitung", waiting: "Wartend", closed: "Geschlossen" }
  },
  ja: {
    sender: "{app}（Bellhop経由）",
    subject: "Re: {title}（#{number}・{app}）",
    confirmSubject: "Bellhopのメール通知登録をご確認ください",
    confirmIntro: "Bellhopのチケットに関する更新をメールで受け取るには、登録を確認してください。",
    confirmAction: "登録を確認する",
    ignore: "心当たりがない場合は、このメールを無視してください。",
    unsubscribe: "このチケットのメール通知を停止",
    stop: "Bellhopからのすべてのメールを停止",
    view: "チケット #{number} を見る",
    answer: "このメールに返信すると、チケットに回答できます。",
    noteAnswer: "このメールに返信すると、内部メモを追加できます。",
    nudge: "このチケットについて、チームが返信をお待ちしています。",
    assigned: "このチケットの担当者に指定されました",
    mentioned: "チケットでメンションされました",
    reply: "返信",
    mention: "メンション",
    by: "{author}さんからの{label}",
    note: "内部メモ",
    attachment: "（添付ファイル）",
    status: "ステータス：{status}",
    statuses: { open: "未対応", in_progress: "対応中", waiting: "返答待ち", closed: "クローズ" }
  },
  "zh-CN": {
    sender: "{app}（通过 Bellhop）",
    subject: "回复：{title}（#{number} · {app}）",
    confirmSubject: "请确认你的 Bellhop 邮件订阅",
    confirmIntro: "请确认你希望通过邮件接收 Bellhop 工单的更新。",
    confirmAction: "确认订阅",
    ignore: "如果这不是你的请求，请忽略这封邮件。",
    unsubscribe: "取消订阅此工单",
    stop: "退订所有 Bellhop 邮件",
    view: "查看工单 #{number}",
    answer: "直接回复这封邮件即可回复工单。",
    noteAnswer: "回复这封邮件即可添加内部备注。",
    nudge: "团队正在等待你回复此工单。",
    assigned: "此工单已分配给你",
    mentioned: "有人在工单中提到了你",
    reply: "回复",
    mention: "提及",
    by: "来自 {author} 的{label}",
    note: "内部备注",
    attachment: "（附件）",
    status: "状态：{status}",
    statuses: { open: "待处理", in_progress: "处理中", waiting: "等待回复", closed: "已关闭" }
  },
  ko: {
    sender: "{app} (Bellhop 경유)",
    subject: "답장: {title} (#{number} · {app})",
    confirmSubject: "Bellhop 이메일 구독을 확인해 주세요",
    confirmIntro: "Bellhop 이슈의 업데이트를 이메일로 받으려면 구독을 확인해 주세요.",
    confirmAction: "구독 확인",
    ignore: "직접 요청하지 않았다면 이 이메일을 무시하세요.",
    unsubscribe: "이 이슈 구독 해지",
    stop: "Bellhop 이메일 모두 수신 거부",
    view: "이슈 #{number} 보기",
    answer: "이 이메일에 회신하면 이슈에 답변할 수 있습니다.",
    noteAnswer: "이 이메일에 회신하면 내부 메모를 남길 수 있습니다.",
    nudge: "팀에서 이 이슈에 대한 답변을 기다리고 있습니다.",
    assigned: "이 이슈가 나에게 배정되었습니다",
    mentioned: "이슈에서 나를 언급했습니다",
    reply: "답변",
    mention: "언급",
    by: "{author}님의 {label}",
    note: "내부 메모",
    attachment: "(첨부 파일)",
    status: "상태: {status}",
    statuses: { open: "접수됨", in_progress: "진행 중", waiting: "답변 대기 중", closed: "종료됨" }
  }
}

// Substitute only catalog placeholders, never recursively interpret the user's text.
export const formatMail = (template: string, fields: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(fields[key]))
