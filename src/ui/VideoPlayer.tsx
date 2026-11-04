import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import "../styles/video.css"

const speeds = [0.5, 1, 1.25, 1.5, 2]

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  const ss = String(s).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

/** Bellhop's own player for uploaded videos and screen recordings: flat controls that hide while playing. */
export function VideoPlayer({ src }: { src: string }) {
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const playedBar = useRef<HTMLSpanElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [playing, setPlaying] = useState(false)
  const [started, setStarted] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [waiting, setWaiting] = useState(false)
  const [failed, setFailed] = useState(false)
  const [full, setFull] = useState(false)
  const [awake, setAwake] = useState(true)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)

  const v = () => video.current!

  const toggle = useCallback(() => {
    const el = video.current
    if (!el) return
    if (el.paused || el.ended) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const seek = useCallback((to: number) => {
    const el = video.current
    if (!el || !Number.isFinite(el.duration)) return
    el.currentTime = Math.min(Math.max(0, to), el.duration)
    setTime(el.currentTime)
  }, [])

  // Controls stay while paused; while playing they fade after a moment of no pointer movement.
  const wake = useCallback(() => {
    setAwake((a) => (a ? a : true))
    clearTimeout(idle.current)
    idle.current = setTimeout(() => setAwake(false), 2200)
  }, [])
  useEffect(() => () => clearTimeout(idle.current), [])

  const playedRatio = duration ? Math.min(Math.max(time / duration, 0), 1) : 0
  const bufferedRatio = Math.min(Math.max(buffered / 100, 0), 1)
  const showControls = !playing || awake || !!hover

  // timeupdate only fires about four times a second; while playing and visible, move the bar via compositor transforms.
  useEffect(() => {
    if (!playing || !showControls) return
    let frame = 0
    const tick = () => {
      const el = video.current
      if (el && el.duration) {
        const ratio = Math.min(Math.max(el.currentTime / el.duration, 0), 1)
        if (playedBar.current) playedBar.current.style.transform = `translateY(-50%) scaleX(${ratio})`
        if (thumb.current) thumb.current.style.transform = `translateX(${ratio * 100}%)`
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, showControls])

  useEffect(() => {
    const onFull = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener("fullscreenchange", onFull)
    return () => document.removeEventListener("fullscreenchange", onFull)
  }, [])

  const fullscreen = () => {
    const el = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null
    if (document.fullscreenElement) void document.exitFullscreen()
    else if (box.current?.requestFullscreen) void box.current.requestFullscreen()
    else el?.webkitEnterFullscreen?.() // iOS Safari only fullscreens the video element itself
  }

  const pip = async () => {
    const el = video.current
    if (!el) return
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else await el.requestPictureInPicture().catch(() => {})
  }

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, .video-menu")) return
    const el = video.current
    if (!el) return
    const handled = (() => {
      switch (e.key) {
        case " ":
        case "k":
          toggle()
          return true
        case "ArrowLeft":
          seek(el.currentTime - 5)
          return true
        case "ArrowRight":
          seek(el.currentTime + 5)
          return true
        case "j":
          seek(el.currentTime - 10)
          return true
        case "l":
          seek(el.currentTime + 10)
          return true
        case "m":
          el.muted = !el.muted
          return true
        case "f":
          fullscreen()
          return true
      }
      if (/^[0-9]$/.test(e.key) && Number.isFinite(el.duration)) {
        seek((Number(e.key) / 10) * el.duration)
        return true
      }
      return false
    })()
    if (handled) {
      e.preventDefault()
      wake()
    }
  }

  const scrubAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.min(Math.max(0, e.clientX - r.left), r.width)
    return { x, t: r.width ? (x / r.width) * duration : 0 }
  }

  const canPip = typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled

  if (failed)
    return (
      <div className="video" data-failed>
        <p>This video can't be played here.</p>
        <a className="btn" href={src} download>
          Download
        </a>
      </div>
    )

  return (
    <div
      ref={box}
      className="video"
      data-playing={playing || undefined}
      data-controls={showControls || undefined}
      data-full={full || undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerMove={wake}
      onPointerLeave={() => playing && setAwake(false)}
      onClick={(e) => e.stopPropagation()}
    >
      <video
        ref={video}
        className="video-el"
        src={src}
        preload="metadata"
        playsInline
        onClick={toggle}
        onDoubleClick={fullscreen}
        onPlay={() => {
          setPlaying(true)
          setStarted(true)
          wake()
        }}
        onPause={() => {
          setPlaying(false)
          setAwake(true)
        }}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setTime(v().currentTime)}
        onLoadedMetadata={() => setDuration(v().duration)}
        onDurationChange={() => setDuration(v().duration)}
        onProgress={() => {
          const el = v()
          if (el.buffered.length && Number.isFinite(el.duration)) setBuffered((el.buffered.end(el.buffered.length - 1) / el.duration) * 100)
        }}
        onVolumeChange={() => setMuted(v().muted)}
        onRateChange={() => setSpeed(v().playbackRate)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onError={() => setFailed(true)}
      />

      {!started && (
        <button type="button" className="video-big" aria-label="Play video" onClick={toggle}>
          <PlayGlyph />
        </button>
      )}
      {waiting && playing && <span className="video-spinner" aria-hidden="true" />}

      <div className="video-bar">
        <div
          className="video-track"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration) || 0}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            seek(scrubAt(e).t)
          }}
          onPointerMove={(e) => {
            const at = scrubAt(e)
            setHover(at)
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(at.t)
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.stopPropagation()
              e.preventDefault()
              seek(time + (e.key === "ArrowLeft" ? -5 : 5))
            }
          }}
        >
          <span className="video-buffered" style={{ transform: `translateY(-50%) scaleX(${bufferedRatio})` }} />
          <span ref={playedBar} className="video-played" style={{ transform: `translateY(-50%) scaleX(${playedRatio})` }} />
          <span ref={thumb} className="video-thumb-pos" style={{ transform: `translateX(${playedRatio * 100}%)` }}>
            <span className="video-thumb" />
          </span>
          {hover && duration > 0 && (
            <span className="video-tip" style={{ left: hover.x }}>
              {clock(hover.t)}
            </span>
          )}
        </div>

        <div className="video-row">
          <button type="button" className="video-btn" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
            {playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>
          <button
            type="button"
            className="video-btn"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => (v().muted = !v().muted)}
          >
            {muted ? <MutedGlyph /> : <VolumeGlyph />}
          </button>
          <span className="video-time">
            {clock(time)} <span className="video-time-total">/ {clock(duration)}</span>
          </span>
          <span className="video-spacer" />
          <SpeedMenu speed={speed} onPick={(s) => (v().playbackRate = s)} />
          {canPip && (
            <button type="button" className="video-btn" aria-label="Picture in picture" onClick={() => void pip()}>
              <PipGlyph />
            </button>
          )}
          <a className="video-btn" href={src} download aria-label="Download">
            <DownloadGlyph />
          </a>
          <button type="button" className="video-btn" aria-label={full ? "Exit full screen" : "Full screen"} onClick={fullscreen}>
            {full ? <ShrinkGlyph /> : <ExpandGlyph />}
          </button>
        </div>
      </div>
    </div>
  )
}

function SpeedMenu({ speed, onPick }: { speed: number; onPick: (s: number) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", close)
    return () => document.removeEventListener("pointerdown", close)
  }, [open])
  return (
    <div className="video-speed" ref={ref}>
      <button
        type="button"
        className="video-btn video-btn-text"
        aria-label="Playback speed"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {speed}×
      </button>
      {open && (
        <div className="video-menu" role="menu">
          {speeds.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === speed}
              onClick={() => {
                onPick(s)
                setOpen(false)
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)
const PlayGlyph = () => (
  <Svg>
    <path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.3-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none" />
  </Svg>
)
const PauseGlyph = () => (
  <Svg>
    <rect x="4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" />
    <rect x="9.4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" />
  </Svg>
)
const VolumeGlyph = () => (
  <Svg>
    <path d="M2.5 6.2v3.6h2.4L8 12.5v-9L4.9 6.2z" fill="currentColor" stroke="none" />
    <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.4 3.6a6 6 0 0 1 0 8.8" />
  </Svg>
)
const MutedGlyph = () => (
  <Svg>
    <path d="M2.5 6.2v3.6h2.4L8 12.5v-9L4.9 6.2z" fill="currentColor" stroke="none" />
    <path d="m10.5 6 3.5 4M14 6l-3.5 4" />
  </Svg>
)
const PipGlyph = () => (
  <Svg>
    <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" />
    <rect x="8" y="8" width="4.5" height="3.2" rx="0.6" fill="currentColor" stroke="none" />
  </Svg>
)
const DownloadGlyph = () => (
  <Svg>
    <path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10" />
  </Svg>
)
const ExpandGlyph = () => (
  <Svg>
    <path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" />
  </Svg>
)
const ShrinkGlyph = () => (
  <Svg>
    <path d="M6 2.75V6H2.75M13.25 6H10V2.75M10 13.25V10h3.25M2.75 10H6v3.25" />
  </Svg>
)
