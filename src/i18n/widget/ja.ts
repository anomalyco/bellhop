import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "チャットを開く",
  "launcher.close": "チャットを閉じる",
  "launcher.unread": { other: "未読メッセージ {count} 件" },
  "panel.label": "チャット",
  "panel.close": "閉じる",
  "panel.back": "戻る",
  "panel.fallbackTitle": "サポート",

  // Home
  "home.title": "どのようなご用件ですか？",
  "home.greeting": "こんにちは、{name}さん",
  "home.text": "なんでもお気軽にどうぞ。通常は数分以内にお返事します。",
  "home.new": "新しいチャット",
  "home.recent": "最近のチャット",
  "home.empty": "まだチャットはありません。",
  "home.loading": "チャットを読み込み中…",
  "home.more": "もっと見る",

  // Conversation list rows and status
  "status.open": "受付中",
  "status.in_progress": "対応中",
  "status.waiting": "お返事待ち",
  "status.closed": "完了",
  "row.unread": { other: "新着 {count} 件" },
  "row.you": "あなた: {text}",
  "row.attachment": "添付ファイル",

  // Conversation
  "conversation.new": "新しいチャット",
  "conversation.you": "あなた",
  "conversation.team": "サポート",
  "conversation.agent": "AI",
  "conversation.agentLabel": "AIアシスタント",
  "conversation.loading": "メッセージを読み込み中…",
  "conversation.earlier": "以前のメッセージを表示",
  "conversation.empty": "ご用件をお書きください。こちらでお返事します。",
  "conversation.typing": "{name}さんが入力中…",
  "conversation.someone": "誰か",
  "conversation.edited": "編集済み",
  "conversation.closedNote": "このチャットは終了しました。メッセージを送ると再開できます。",
  "conversation.attachment": "添付ファイル: {name}",

  // Events in the thread
  "event.closed": "チャットが終了しました",
  "event.reopened": "チャットが再開されました",
  "event.in_progress": "対応しています",
  "event.waiting": "お返事をお待ちしています",
  "event.assigned": "{name}さんがチャットに参加しました",
  "event.unassigned": "担当者の割り当て待ちです",
  "event.verificationRequested": "メールアドレスの確認をお願いしました",
  "event.verified": "メールアドレスを確認しました",

  // Composer
  "composer.placeholder": "メッセージを入力…",
  "composer.firstPlaceholder": "ご用件を入力…",
  "composer.send": "送信",
  "composer.hint": "Enterで送信、Shift+Enterで改行",
  "composer.sending": "送信中…",
  "composer.failed": "送信できませんでした。",
  "composer.retry": "再試行",

  // Verification card (the team asked to confirm an email)
  "verify.title": "メールアドレスの確認",
  "verify.text": "{email} に6桁のコードを送信しました。ご本人確認のため、ここに入力してください。",
  "verify.code": "コード",
  "verify.submit": "確認",
  "verify.checking": "確認中…",
  "verify.done": "{email} を確認しました。",
  "verify.wrong": "コードが正しくありません。確認してもう一度お試しください。",
  "verify.expired": "コードの有効期限が切れました。新しいコードをご依頼ください。",
  "verify.failed": "試行回数が上限に達しました。新しいコードをご依頼ください。",

  // Email capture (anonymous or not yet verified)
  "email.title": "メールアドレスを教えてください",
  "email.text": "ご本人確認のためコードをお送りします。確認後、ここでもメールでもお返事できます。",
  "email.label": "メールアドレス",
  "email.placeholder": "you@example.com",
  "email.continue": "続ける",
  "email.sending": "コードを送信中…",
  "email.codeTitle": "メールをご確認ください",
  "email.codeText": "{email} に送信した6桁のコードを入力してください。",
  "email.code": "コード",
  "email.verify": "確認",
  "email.verifying": "確認中…",
  "email.change": "別のメールアドレスを使う",
  "email.resend": "コードを再送信",
  "email.resent": "新しいコードを送信しました。",
  "email.invalid": "有効なメールアドレスを入力してください。",
  "email.wrongCode": "コードが正しくありません。確認してもう一度お試しください。",
  "email.human": "ロボットでないことを確認中…",

  // Connection and errors
  "state.reconnecting": "再接続中…",
  "state.offline": "オフラインです。接続が戻ったら同期します。",
  "state.ended": "セッションが終了しました。チャットを続けるには、もう一度開始してください。",
  "state.restart": "もう一度開始",
  "error.generic": "問題が発生しました。もう一度お試しください。",
  "error.rateLimited": "リクエストが多すぎます。しばらくしてからお試しください。",
  "error.unavailable": "現在チャットはご利用いただけません。",

  // ログインした顧客のみチャットできるサイトの訪問者向け（{host} はサイト名。例: app.example.com）
  "signin.title": "サポートへのお問い合わせは {host} にログインしてください",
  "signin.text": "チャットはログイン中のお客様のみご利用いただけます。ログインすると、ここからチャットを始められます。",

  // 以前のメッセージと添付ファイル
  "conversation.older": "以前のメッセージを読み込み中…",
  "composer.attach": "ファイルを添付",
  "composer.removeFile": "{name} を削除",
  "upload.uploading": "{name} をアップロード中…",
  "upload.tooLarge": "{name} はサイズが大きすぎます。画像は10 MB、動画は100 MB、その他のファイルは25 MBまでです。",
  "upload.quota": "本日のアップロード上限に達しました。代わりにメッセージで内容をお伝えいただくか、明日もう一度お試しください。",
  "upload.type": "{name} はここでは送信できません。別のファイルをお試しください。",
  "upload.rateLimited": "直近1時間のアップロードが多すぎます。しばらくしてからお試しください。",
  "upload.failed": "{name} をアップロードできませんでした。もう一度お試しください。",

  // Starting a conversation where the workspace has request types: pick one, then fill in its fields
  "types.title": "どのようなことでお困りですか？",
  "types.other": "その他",
  "types.otherText": "上記に当てはまらない内容。",
  "types.change": "変更",
  "types.changed": "フォームが更新されました。内容を確認して、もう一度送信してください。",
  "field.choose": "選択…",
  "field.verifyNote": "確認のためにコードをお送りします。",
  "field.required": "入力してください。",
  "field.email": "有効なメールアドレスを入力してください。",
  "field.url": "https:// から始まる完全なリンクを入力してください。",
  "field.number": "数値を入力してください。",
  "field.option": "選択肢から1つ選んでください。",
  "field.invalid": "この項目を確認してください。",
}

export default messages
