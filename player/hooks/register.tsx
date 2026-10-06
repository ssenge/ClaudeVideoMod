import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

const PANE = 'player'
const W = 640
const H = 360
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128 Safari/537.36'
const YTDLP = ['uvx', 'yt-dlp', '-q', '--no-warnings']

type Video = { video: string; audio: string }

// ponytail: module variables, not $.state; a reload kills the children and re-arms from the config
let source: string | undefined // armed source; plays only while a turn runs
let pick = 'newest'
let linkPattern = ''
let entries: string[] = []
let index = -1
let current: Video | undefined
let ready: Promise<void> | undefined // resolving `current`
let offset = 0 // seconds of `current` already watched, so the next turn resumes there
let startedAt = 0
let isTurn = false
let isPaused = false // the person pressed Stop; holds across turns until Play or /play
let frame: string | undefined
let isReady = false
let children: HookStream<ProcessSpawnChunk, ProcessSpawnResult>[] = []
let ticker: { cancel: () => void } | undefined

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'play', description: 'Play videos while Claude works: /play [url|ytsearch:…], /play off' })
    pick = String(options.pick ?? 'newest')
    linkPattern = String(options.linkPattern ?? '')
    if (options.source) arm($, String(options.source))
    return next(e)
  })

  on('command.run', { command: 'play' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      disarm()
      await $.ui.close({ id: PANE })
      return { text: 'Player off.' }
    }
    const src = arg || String(options.source ?? '')
    if (!src) return { text: 'No source: /play <url>, or set one in /config.' }
    arm($, src)
    return { text: `Player armed with ${src}: it plays while Claude works and pauses when the turn ends. /play off disarms.` }
  })

  on('turn.start', async ($, e, next) => {
    isTurn = true
    if (isPaused) await $.ui.open({ id: PANE, title: 'Player' })
    else void playWhenReady($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isTurn = false
    if (children.length > 0) await pause($)
    if (source) await $.ui.close({ id: PANE })
    return next(e)
  })

  // the person closing the pane mid-turn means "not now": disarm, so it does not pop up again
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') disarm()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e) // Image is the terminal's element alone
    const { Box, Text, Image, Button } = $.ui.resolve(e)
    const label = <Text dimColor>{entries[index] ?? ''} · /play off disarms</Text>
    if (isPaused) {
      const resume = () => {
        isPaused = false
        $.ui.invalidate('ui.render')
        return playWhenReady($)
      }
      return (
        <Box flexDirection="column">
          <Text dimColor>Paused at {Math.floor(offset / 60)}:{String(Math.floor(offset % 60)).padStart(2, '0')}</Text>
          <Box gap={2}><Button key="play" variant="primary" onPress={resume}>▶ Play</Button>{label}</Box>
        </Box>
      )
    }
    if (!frame || !isReady) return <Text dimColor>Buffering…</Text>

    const columns = Math.max(20, Math.min(160, e.props.bodyColumns))
    const rows = Math.round((columns * H) / W / 2)
    return (
      <Box flexDirection="column">
        <Image key="view" source={{ file: frame, format: 'rgb', width: W, height: H }} columns={columns} rows={rows} alt="video (needs kitty or Ghostty)" />
        <Box gap={2}>
          <Button key="stop" onPress={async () => { isPaused = true; await pause($); $.ui.invalidate('ui.render') }}>■ Stop</Button>
          {label}
        </Box>
      </Box>
    )
  })
}

function arm($: EngineInterface, src: string) {
  disarm()
  source = src
  ready = advance($)
}

function disarm() {
  stop()
  isPaused = false
  source = undefined
  entries = []
  index = -1
  current = undefined
  ready = undefined
}

// moves to the source's next video and resolves its streams
async function advance($: EngineInterface) {
  const src = source
  if (!src) return
  try {
    if (entries.length === 0) {
      const list = await $.process.run([...YTDLP, '--flat-playlist', '--playlist-end', '20', '--print', '%(webpage_url,url)s', src], { timeoutMs: 90_000 })
      entries = list.stdout.split('\n').map(l => l.trim()).filter(Boolean)
      if (entries.length === 0 && linkPattern) entries = await scrape($, src, linkPattern)
      if (entries.length === 0) entries = [src] // not a page yt-dlp knows: let ffmpeg try the URL as a stream
    }
    index = pick === 'random' ? Math.floor(Math.random() * entries.length) : (index + 1) % entries.length
    const entry = entries[index] ?? src
    // separate best video + audio (YouTube serves them apart), else one combined file
    const got = await $.process.run([...YTDLP, '-f', 'bv*[height<=480]+ba/b[height<=480]/b', '-g', entry], { timeoutMs: 90_000 })
    const [video, audio] = got.exitCode === 0 ? got.stdout.split('\n').map(l => l.trim()).filter(Boolean) : []
    if (source !== src) return // re-armed meanwhile
    current = { video: video ?? entry, audio: audio ?? video ?? entry }
    offset = 0
  } catch (err) {
    $.ui.status(`player: ${String(err)}`)
  }
}

// the video links on a page yt-dlp cannot list, by the configured pattern
// ponytail: curl, not $.http.fetch: some sites refuse anything but a full browser user agent
async function scrape($: EngineInterface, page: string, pattern: string) {
  const got = await $.process.run(['curl', '-sL', '-A', UA, page], { timeoutMs: 30_000 })
  const links = (got.stdout.match(new RegExp(pattern, 'g')) ?? []).map(l => new URL(l, page).href)
  return [...new Set(links)].slice(0, 20)
}

// stops playback and keeps the position for the next start
async function pause($: EngineInterface) {
  offset += ((await $.clock.now()) - startedAt) / 1000
  stop()
}

// starts once the current video is resolved, if a turn still runs and nothing plays yet
async function playWhenReady($: EngineInterface) {
  await ready
  if (ready && isTurn && !isPaused && children.length === 0) await start($)
}

async function start($: EngineInterface) {
  const v = current
  if (!v) return
  const dir = (await $.process.run(['mktemp', '-d'])).stdout.trim()
  frame = `${dir}/frame.rgb`
  startedAt = await $.clock.now()
  if (!isTurn || children.length > 0) return // the turn ended, or another start won, while we awaited
  const seek = ['-ss', offset.toFixed(1)]

  // -re paces decoding at playback speed; atomic writes so the terminal never reads half a frame
  const ffmpeg = $.process.spawn({ argv: ['ffmpeg', '-loglevel', 'error', '-re', ...seek, '-user_agent', UA, '-i', v.video,
    '-an', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-c:v', 'rawvideo',
    '-f', 'image2', '-update', '1', '-atomic_writing', '1', frame] })
  const ffplay = $.process.spawn({ argv: ['ffplay', '-loglevel', 'error', '-nodisp', '-autoexit', '-vn', ...seek, '-user_agent', UA, v.audio] })
  children = [ffmpeg, ffplay]
  void drain($, ffmpeg, true)
  void drain($, ffplay, false)

  const opened = await $.ui.open({ id: PANE, title: 'Player' })
  if (!opened.isPlaced) $.ui.toast('player: widen the terminal to see the video')
  ticker = $.clock.every(33, () => void tick($))
}

async function tick($: EngineInterface) {
  if (!frame) return
  if (!isReady) {
    if ((await $.process.run(['test', '-s', frame])).exitCode !== 0) return
    isReady = true
    $.ui.invalidate('ui.render')
    return
  }
  const r = await $.ui.blit({ requestId: PANE, key: 'view', source: { file: frame, format: 'rgb', width: W, height: H } })
  if ('deny' in r && r.deny) $.ui.status(`player: ${r.deny}`)
}

async function drain($: EngineInterface, child: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, isVideo: boolean) {
  try {
    for await (const piece of child) if (piece.text) $.ui.log(piece.text, { to: 'debug' })
  } catch {}
  // ffmpeg ending on its own (video over, or a dead link): on to the next video
  // ponytail: a source whose every entry fails cycles through them each turn; /play off ends it
  if (isVideo && children.includes(child)) {
    stop()
    $.ui.invalidate('ui.render')
    ready = advance($)
    void playWhenReady($)
  }
}

function stop() {
  ticker?.cancel()
  const old = children
  children = []
  for (const child of old) void child.return(undefined as never) // ending the stream kills the child
  ticker = undefined
  frame = undefined
  isReady = false
}
