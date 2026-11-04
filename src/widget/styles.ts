// The widget's styles, scoped by its shadow root. `.root` resets everything it inherits from the host page, so a
// site's global CSS (even `* { all: unset }`) can't reach inside. Light and dark themes; flat, 6 px corners, no
// gradients. --bw-accent is the hook for a workspace accent colour.
export const css = `
:host{all:initial!important;display:contents!important}
.root{all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:20px;color:var(--bw-fg);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;text-align:left;direction:ltr;
--bw-bg:#fff;--bw-surface:#f4f4f4;--bw-raised:#fff;--bw-fg:#161616;--bw-muted:#5c5c5c;--bw-faint:#808080;--bw-border:rgb(0 0 0/.1);--bw-hover:rgb(0 0 0/.05);--bw-accent:#161616;--bw-accent-fg:#fff;--bw-danger:#c4302b;--bw-ok:#1d7a3c;--bw-focus:#3b5cf6;--bw-shadow:0 12px 32px rgb(0 0 0/.16),0 2px 6px rgb(0 0 0/.08),0 0 0 .5px rgb(0 0 0/.12)}
.root[data-theme=dark]{--bw-bg:#161616;--bw-surface:#242424;--bw-raised:#2e2e2e;--bw-fg:#fafafa;--bw-muted:#aeaeae;--bw-faint:#808080;--bw-border:rgb(255 255 255/.1);--bw-hover:rgb(255 255 255/.06);--bw-accent:#ebebeb;--bw-accent-fg:#161616;--bw-danger:#f17471;--bw-ok:#6bd586;--bw-focus:#7698fd;--bw-shadow:0 12px 32px rgb(0 0 0/.5),0 0 0 .5px rgb(255 255 255/.16);color-scheme:dark}
@media (prefers-color-scheme:dark){.root[data-theme=auto]{--bw-bg:#161616;--bw-surface:#242424;--bw-raised:#2e2e2e;--bw-fg:#fafafa;--bw-muted:#aeaeae;--bw-faint:#808080;--bw-border:rgb(255 255 255/.1);--bw-hover:rgb(255 255 255/.06);--bw-accent:#ebebeb;--bw-accent-fg:#161616;--bw-danger:#f17471;--bw-ok:#6bd586;--bw-focus:#7698fd;--bw-shadow:0 12px 32px rgb(0 0 0/.5),0 0 0 .5px rgb(255 255 255/.16);color-scheme:dark}}
.root *,.root *::before,.root *::after{box-sizing:border-box;margin:0;padding:0;border:0;font:inherit;color:inherit;letter-spacing:normal;text-transform:none;text-decoration:none;background:none;list-style:none;max-width:none;min-width:0;float:none;opacity:1;visibility:inherit}
.root[data-position=left]{inset:auto auto 0 0}
button,input,textarea{appearance:none;-webkit-appearance:none;cursor:pointer;outline:none}
input,textarea{cursor:text}
:focus-visible{outline:2px solid var(--bw-focus)!important;outline-offset:2px}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
[hidden]{display:none!important}

.launcher{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;background:var(--bw-accent);color:var(--bw-accent-fg);display:grid;place-items:center;box-shadow:var(--bw-shadow);transition:transform .15s cubic-bezier(.2,0,0,1)}
.root[data-position=left] .launcher{right:auto;left:20px}
.launcher:active{transform:scale(.96)}
.launcher svg{width:24px;height:24px}
.badge{position:absolute;top:-4px;right:-4px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#e5484d;color:#fff;font-size:12px;font-weight:600;line-height:22px;text-align:center;box-shadow:0 0 0 2px var(--bw-bg);font-variant-numeric:tabular-nums}

.panel{position:fixed;right:20px;bottom:88px;width:380px;height:min(640px,calc(100vh - 120px));display:flex;flex-direction:column;background:var(--bw-bg);border-radius:12px;box-shadow:var(--bw-shadow);overflow:hidden;transform-origin:bottom right;animation:bw-in .18s cubic-bezier(.2,0,0,1)}
.root[data-position=left] .panel{right:auto;left:20px;transform-origin:bottom left}
@keyframes bw-in{from{opacity:0;transform:translateY(8px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.panel{animation:none}.launcher{transition:none}}
@media (max-width:520px){
.panel{inset:0;width:auto;height:auto;border-radius:0;box-shadow:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);animation:none}
.root[data-open] .launcher{display:none}
}

.head{display:flex;align-items:center;gap:4px;min-height:56px;padding:6px 6px 6px 8px;border-bottom:1px solid var(--bw-border);flex:none}
.title{flex:1;display:flex;align-items:center;gap:10px;min-width:0;padding:0 6px;font-size:15px;font-weight:600}
.title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.icon{width:28px;height:28px;border-radius:6px;object-fit:cover;flex:none}
.icon-btn{width:44px;height:44px;border-radius:6px;display:grid;place-items:center;color:var(--bw-muted);flex:none}
.icon-btn:hover{background:var(--bw-hover);color:var(--bw-fg)}
.icon-btn svg{width:20px;height:20px}
.notice{flex:none;padding:8px 16px;font-size:13px;background:var(--bw-surface);color:var(--bw-muted);border-bottom:1px solid var(--bw-border);display:flex;gap:8px;align-items:center;justify-content:space-between}
.body{flex:1;display:flex;flex-direction:column;min-height:0;position:relative}
.scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}

.home{padding:24px 16px 16px;display:flex;flex-direction:column;gap:20px}
.hello h2{font-size:22px;line-height:28px;font-weight:650;letter-spacing:-.01em}
.hello p{margin-top:6px;color:var(--bw-muted)}
.btn{min-height:44px;padding:0 16px;border-radius:6px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.btn svg{width:18px;height:18px;flex:none}
.btn.primary{background:var(--bw-accent);color:var(--bw-accent-fg)}
.btn.primary:disabled{opacity:.5;cursor:default}
.btn.quiet{color:var(--bw-muted);font-weight:500}
.btn.quiet:hover{color:var(--bw-fg);background:var(--bw-hover)}
.btn.block{width:100%}
.section{font-size:12px;font-weight:600;color:var(--bw-faint);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
.list{display:flex;flex-direction:column;border:1px solid var(--bw-border);border-radius:8px;overflow:hidden}
.row{display:flex;flex-direction:column;gap:2px;padding:12px 14px;min-height:56px;text-align:left;border-top:1px solid var(--bw-border);width:100%}
.row:first-child{border-top:0}
.row:hover{background:var(--bw-hover)}
.row-top{display:flex;align-items:center;gap:8px}
.row-subject{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-time{font-size:12px;color:var(--bw-faint);flex:none}
.row-bottom{display:flex;align-items:center;gap:8px;color:var(--bw-muted);font-size:13px}
.row-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{flex:none;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--bw-surface);color:var(--bw-muted);line-height:18px}
.pill.unread{background:var(--bw-accent);color:var(--bw-accent-fg)}
.empty{color:var(--bw-muted);padding:16px 14px;text-align:center}
.muted{color:var(--bw-muted)}

.thread{padding:16px 12px 8px;display:flex;flex-direction:column;gap:2px}
.msg{display:flex;flex-direction:column;align-items:flex-start;max-width:86%;margin-top:10px}
.msg.cont{margin-top:2px}
.msg.mine{align-self:flex-end;align-items:flex-end}
.who{font-size:12px;color:var(--bw-faint);margin:0 4px 3px;display:flex;align-items:center;gap:6px}
.ai{font-size:10px;font-weight:700;letter-spacing:.04em;padding:0 5px;border-radius:4px;background:var(--bw-surface);color:var(--bw-muted);line-height:16px}
.bubble{padding:8px 12px;border-radius:6px;background:var(--bw-surface);overflow-wrap:anywhere;word-break:break-word}
.mine .bubble{background:var(--bw-accent);color:var(--bw-accent-fg)}
.bubble p+p,.bubble p+ul,.bubble p+ol,.bubble ul+p,.bubble ol+p{margin-top:8px}
.bubble ul,.bubble ol{padding-left:18px}
.bubble ul li{list-style:disc}
.bubble ol li{list-style:decimal}
.bubble strong{font-weight:650}
.bubble em{font-style:italic}
.bubble code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;padding:1px 4px;border-radius:4px;background:var(--bw-hover)}
.bubble a{text-decoration:underline;text-underline-offset:2px}
.meta{font-size:11px;color:var(--bw-faint);margin:3px 4px 0}
.meta.err{color:var(--bw-danger)}
.meta button{text-decoration:underline;color:inherit;font-weight:600;padding:0 2px}
.event{align-self:center;font-size:12px;color:var(--bw-faint);margin:12px 0 4px;text-align:center}
.live{font-size:12px;color:var(--bw-muted);padding:4px 16px 6px;min-height:26px;display:flex;align-items:center;gap:6px;flex:none}
.dots{display:inline-flex;gap:3px}
.dots i{width:4px;height:4px;border-radius:50%;background:currentColor;animation:bw-dot 1.2s infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes bw-dot{0%,60%,100%{opacity:.3}30%{opacity:1}}

.card{margin:8px 12px;padding:14px;border:1px solid var(--bw-border);border-radius:8px;background:var(--bw-raised);display:flex;flex-direction:column;gap:10px;flex:none}
.card h3{font-weight:650}
.card p{color:var(--bw-muted);font-size:13px}
.field{display:flex;gap:8px}
.input{flex:1;min-height:44px;padding:0 12px;border-radius:6px;background:var(--bw-bg);border:1px solid var(--bw-border);color:var(--bw-fg);font-size:16px}
.input:focus{border-color:var(--bw-focus)}
.input.code{letter-spacing:.3em;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.err{color:var(--bw-danger);font-size:13px}
.ok{color:var(--bw-ok);font-size:13px}
.form{padding:24px 16px;display:flex;flex-direction:column;gap:12px}
.form h2{font-size:18px;font-weight:650}
.form label{font-size:13px;font-weight:600}
.links{display:flex;flex-wrap:wrap;gap:4px;margin:0 -8px}
.human:empty{display:none}

.composer{flex:none;border-top:1px solid var(--bw-border);padding:8px;display:flex;align-items:flex-end;gap:6px;background:var(--bw-bg)}
.composer textarea{flex:1;min-height:44px;max-height:140px;padding:11px 10px;border-radius:6px;background:var(--bw-surface);resize:none;font-size:15px;line-height:22px;color:var(--bw-fg);overflow-y:auto}
.composer textarea::placeholder,.input::placeholder{color:var(--bw-faint)}
.send{width:44px;height:44px;border-radius:6px;background:var(--bw-accent);color:var(--bw-accent-fg);display:grid;place-items:center;flex:none}
.send:disabled{opacity:.35;cursor:default}
.send svg{width:18px;height:18px}
@media (max-width:520px){.composer textarea{font-size:16px}}
`
