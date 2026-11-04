import type { Translation } from "../index"
import type en from "./en"

const messages: Translation<typeof en> = {
  // Launcher and panel
  "launcher.open": "채팅 열기",
  "launcher.close": "채팅 닫기",
  "launcher.unread": { other: "읽지 않은 메시지 {count}개" },
  "panel.label": "채팅",
  "panel.close": "닫기",
  "panel.back": "뒤로",
  "panel.fallbackTitle": "고객 지원",

  // Home
  "home.title": "무엇을 도와드릴까요?",
  "home.greeting": "{name}님, 안녕하세요",
  "home.text": "무엇이든 물어보세요. 보통 몇 분 안에 답변드려요.",
  "home.new": "새 대화",
  "home.recent": "최근 대화",
  "home.empty": "아직 대화가 없어요.",
  "home.loading": "대화를 불러오는 중…",
  "home.more": "더 보기",

  // Conversation list rows and status
  "status.open": "진행 전",
  "status.in_progress": "처리 중",
  "status.waiting": "답변 대기 중",
  "status.closed": "종료됨",
  "row.unread": { other: "새 메시지 {count}개" },
  "row.you": "나: {text}",
  "row.attachment": "첨부 파일",

  // Conversation
  "conversation.new": "새 대화",
  "conversation.you": "나",
  "conversation.team": "팀",
  "conversation.agent": "AI",
  "conversation.agentLabel": "AI 어시스턴트",
  "conversation.loading": "메시지를 불러오는 중…",
  "conversation.earlier": "이전 메시지 보기",
  "conversation.empty": "필요한 내용을 남겨 주시면 여기에서 답변드릴게요.",
  "conversation.typing": "{name}님이 입력 중…",
  "conversation.someone": "누군가",
  "conversation.edited": "수정됨",
  "conversation.closedNote": "종료된 대화예요. 메시지를 보내면 다시 열려요.",
  "conversation.attachment": "첨부 파일: {name}",

  // Events in the thread
  "event.closed": "대화가 종료되었어요",
  "event.reopened": "대화가 다시 열렸어요",
  "event.in_progress": "확인하고 있어요",
  "event.waiting": "답변을 기다리고 있어요",
  "event.assigned": "{name}님이 대화에 참여했어요",
  "event.unassigned": "다시 대기열로 돌아갔어요",
  "event.verificationRequested": "이메일 인증을 요청했어요",
  "event.verified": "이메일 인증 완료",

  // Composer
  "composer.placeholder": "메시지를 입력하세요…",
  "composer.firstPlaceholder": "필요한 내용을 알려 주세요…",
  "composer.send": "보내기",
  "composer.hint": "Enter로 보내기, Shift+Enter로 줄바꿈",
  "composer.sending": "보내는 중…",
  "composer.failed": "보내지 못했어요.",
  "composer.retry": "다시 시도",

  // Verification card (the team asked to confirm an email)
  "verify.title": "이메일 인증",
  "verify.text": "{email}(으)로 6자리 코드를 보냈어요. 본인 확인을 위해 여기에 입력해 주세요.",
  "verify.code": "코드",
  "verify.submit": "인증",
  "verify.checking": "확인 중…",
  "verify.done": "{email} 인증이 완료되었어요.",
  "verify.wrong": "코드가 올바르지 않아요. 확인 후 다시 시도해 주세요.",
  "verify.expired": "코드가 만료되었어요. 새 코드를 요청해 주세요.",
  "verify.failed": "시도 횟수를 초과했어요. 새 코드를 요청해 주세요.",

  // Email capture (anonymous or not yet verified)
  "email.title": "이메일 주소를 알려 주세요",
  "email.text": "본인 확인용 코드를 보내 드려요. 확인되면 여기와 이메일로 답변드릴게요.",
  "email.label": "이메일",
  "email.placeholder": "you@example.com",
  "email.continue": "계속",
  "email.sending": "코드 보내는 중…",
  "email.codeTitle": "이메일을 확인해 주세요",
  "email.codeText": "{email}(으)로 보낸 6자리 코드를 입력해 주세요.",
  "email.code": "코드",
  "email.verify": "인증",
  "email.verifying": "인증 중…",
  "email.change": "다른 이메일 사용",
  "email.resend": "새 코드 받기",
  "email.resent": "새 코드를 보냈어요.",
  "email.invalid": "올바른 이메일 주소를 입력해 주세요.",
  "email.wrongCode": "코드가 올바르지 않아요. 확인 후 다시 시도해 주세요.",
  "email.human": "사람인지 확인하는 중…",

  // Connection and errors
  "state.reconnecting": "다시 연결하는 중…",
  "state.offline": "오프라인 상태예요. 다시 연결되면 이어서 불러올게요.",
  "state.ended": "세션이 종료되었어요. 대화를 계속하려면 다시 시작해 주세요.",
  "state.restart": "다시 시작",
  "error.generic": "문제가 발생했어요. 다시 시도해 주세요.",
  "error.rateLimited": "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
  "error.unavailable": "지금은 채팅을 이용할 수 없어요.",

  // 로그인한 고객만 채팅할 수 있는 사이트의 방문자 ({host}는 사이트 주소, 예: app.example.com)
  "signin.title": "고객 지원에 문의하려면 {host}에 로그인해 주세요",
  "signin.text": "채팅은 로그인한 고객만 이용할 수 있어요. 로그인하면 여기에서 대화를 시작할 수 있어요.",

  // 이전 메시지와 첨부 파일
  "conversation.older": "이전 메시지를 불러오는 중…",
  "composer.attach": "파일 첨부",
  "composer.removeFile": "{name} 삭제",
  "upload.uploading": "{name} 업로드 중…",
  "upload.tooLarge": "{name} 파일이 너무 커요. 이미지는 10MB, 동영상은 100MB, 그 밖의 파일은 25MB까지 보낼 수 있어요.",
  "upload.quota": "오늘 업로드 한도에 도달했어요. 메시지로 설명해 주시거나 내일 다시 시도해 주세요.",
  "upload.type": "{name} 파일은 여기에서 보낼 수 없어요. 다른 파일을 사용해 주세요.",
  "upload.rateLimited": "최근 1시간 동안 업로드가 너무 많았어요. 잠시 후 다시 시도해 주세요.",
  "upload.failed": "{name} 업로드에 실패했어요. 다시 시도해 주세요.",

  // Starting a conversation where the workspace has request types: pick one, then fill in its fields
  "types.title": "어떤 도움이 필요하세요?",
  "types.other": "기타",
  "types.otherText": "위 항목에 해당하지 않는 모든 문의",
  "types.change": "변경",
  "types.changed": "양식이 방금 바뀌었어요. 확인하고 다시 보내 주세요.",
  "field.choose": "선택…",
  "field.verifyNote": "확인용 코드를 보내 드려요.",
  "field.required": "이 항목을 입력해 주세요.",
  "field.email": "올바른 이메일 주소를 입력해 주세요.",
  "field.url": "https://로 시작하는 전체 링크를 입력해 주세요.",
  "field.number": "숫자를 입력해 주세요.",
  "field.option": "옵션 중 하나를 선택해 주세요.",
  "field.invalid": "이 항목을 확인해 주세요.",

  // Asking for a person instead of the assistant, in an open conversation
  "handoff.action": "상담원과 이야기하기",
  "handoff.reason": "어떤 도움이 필요하세요?",
  "handoff.reasonHint": "선택 사항",
  "handoff.send": "상담원 요청하기",
  "handoff.cancel": "취소",
  "handoff.sending": "요청하는 중…",
  "handoff.status": "팀이 확인 중",
  "handoff.already": "이 대화에서 이미 상담원을 요청했어요.",
  "event.escalated": "이제 상담원이 도와드릴게요",
}

export default messages
