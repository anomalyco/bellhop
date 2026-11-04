import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "打开聊天",
  "launcher.close": "关闭聊天",
  "launcher.unread": { other: "{count} 条未读消息" },
  "panel.label": "聊天",
  "panel.close": "关闭",
  "panel.back": "返回",
  "panel.fallbackTitle": "客服",

  // Home
  "home.title": "有什么可以帮你？",
  "home.greeting": "你好，{name}",
  "home.text": "有任何问题都可以问我们，通常几分钟内就会回复。",
  "home.new": "新对话",
  "home.recent": "最近的对话",
  "home.empty": "还没有对话。",
  "home.loading": "正在加载对话…",
  "home.more": "显示更多",

  // Conversation list rows and status
  "status.open": "待处理",
  "status.in_progress": "处理中",
  "status.waiting": "等你回复",
  "status.closed": "已关闭",
  "row.unread": { other: "{count} 条新消息" },
  "row.you": "你：{text}",
  "row.attachment": "附件",

  // Conversation
  "conversation.new": "新对话",
  "conversation.you": "你",
  "conversation.team": "团队",
  "conversation.agent": "AI",
  "conversation.agentLabel": "AI 助手",
  "conversation.loading": "正在加载消息…",
  "conversation.earlier": "显示更早的消息",
  "conversation.empty": "告诉我们你需要什么，我们会在这里回复你。",
  "conversation.typing": "{name} 正在输入…",
  "conversation.someone": "有人",
  "conversation.edited": "已编辑",
  "conversation.closedNote": "此对话已关闭。发送消息即可重新开启。",
  "conversation.attachment": "附件：{name}",

  // Events in the thread
  "event.closed": "对话已关闭",
  "event.reopened": "对话已重新开启",
  "event.in_progress": "我们正在处理",
  "event.waiting": "等待你的回复",
  "event.assigned": "{name} 加入了对话",
  "event.unassigned": "已重新排队",
  "event.verificationRequested": "我们请你验证邮箱",
  "event.verified": "邮箱已验证",

  // Composer
  "composer.placeholder": "输入消息…",
  "composer.firstPlaceholder": "描述一下你的需求…",
  "composer.send": "发送",
  "composer.hint": "按 Enter 发送，Shift+Enter 换行",
  "composer.sending": "正在发送…",
  "composer.failed": "发送失败。",
  "composer.retry": "重试",

  // Verification card (the team asked to confirm an email)
  "verify.title": "验证你的邮箱",
  "verify.text": "我们已向 {email} 发送了 6 位验证码。请在此输入，确认这是你的邮箱。",
  "verify.code": "验证码",
  "verify.submit": "验证",
  "verify.checking": "正在验证…",
  "verify.done": "{email} 已验证。",
  "verify.wrong": "验证码无效，请检查后重试。",
  "verify.expired": "验证码已过期，请向我们索取新的验证码。",
  "verify.failed": "尝试次数过多，请向我们索取新的验证码。",

  // Email capture (anonymous or not yet verified)
  "email.title": "你的邮箱是？",
  "email.text": "我们会发送验证码确认你的身份，之后就能在这里和邮件中回复你。",
  "email.label": "邮箱",
  "email.placeholder": "you@example.com",
  "email.continue": "继续",
  "email.sending": "正在发送验证码…",
  "email.codeTitle": "查看你的邮箱",
  "email.codeText": "请输入我们发送到 {email} 的 6 位验证码。",
  "email.code": "验证码",
  "email.verify": "验证",
  "email.verifying": "正在验证…",
  "email.change": "使用其他邮箱",
  "email.resend": "重新发送验证码",
  "email.resent": "新验证码已发送。",
  "email.invalid": "请输入有效的邮箱地址。",
  "email.wrongCode": "验证码无效，请检查后重试。",
  "email.human": "正在进行人机验证…",

  // Connection and errors
  "state.reconnecting": "正在重新连接…",
  "state.offline": "你已离线。恢复网络后我们会自动同步。",
  "state.ended": "会话已结束。重新开始即可继续聊天。",
  "state.restart": "重新开始",
  "error.generic": "出了点问题，请重试。",
  "error.rateLimited": "请求过于频繁，请稍后再试。",
  "error.unavailable": "聊天暂时不可用。",

  // 仅限已登录客户聊天的网站上的访客（{host} 是网站，例如 app.example.com）
  "signin.title": "登录 {host} 以联系客服",
  "signin.text": "聊天仅对已登录的客户开放。登录后即可在这里发起对话。",

  // 更早的消息和附件
  "conversation.older": "正在加载更早的消息…",
  "composer.attach": "添加附件",
  "composer.removeFile": "移除 {name}",
  "upload.uploading": "正在上传 {name}…",
  "upload.tooLarge": "{name} 太大了。图片最大 10 MB，视频最大 100 MB，其他文件最大 25 MB。",
  "upload.quota": "你已达到今天的上传上限。可以改用消息描述，或明天再试。",
  "upload.type": "{name} 无法在此发送，请换一个文件。",
  "upload.rateLimited": "过去一小时内上传次数过多，请稍后再试。",
  "upload.failed": "{name} 上传失败，请重试。",
}

export default messages
