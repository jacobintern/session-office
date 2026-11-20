import type { Register, EngineInterface } from 'claude-code'

// Session Office: every session keeps a desk card as a local file; one bridge
// session (CLAUDE_OFFICE_BRIDGE=1, or `/office bridge`) copies the files into
// the artifact's database and brings instructions typed on the page back as
// files. Workers never call a tool, so they run under auto mode untouched.
// Everything about the person running it lives in ~/.claude/office/config.json:
// { officeUrl, jira?: { site, email, jql?, tokenFile? }, codex?, tutor?, city?: { lat, lng }, newSessionDirs?, language? }
type OfficeConfig = {
  officeUrl?: string
  jira?: { site: string; email: string; jql?: string; tokenFile?: string } | null
  codex?: boolean
  tutor?: boolean
  city?: { lat: number; lng: number }
  newSessionDirs?: string[]
  language?: 'zh-TW' | 'en'
}
let cfg: OfficeConfig = {}
let OFFICE_URL = ''
const COLLECTION = 'desks'
const TICK_MS = 5_000              // workers look for an instruction, the bridge syncs
const HEARTBEAT_EVERY = 12         // seenAt + branch refresh every 12th tick (60 s)
const ACTIVITY_WRITE_MIN_MS = 3_000
const STALE_MS = 30 * 60 * 1000    // a desk file this old is a dead session
const HISTORY_KEEP = 5

type DeskState = 'working' | 'reporting' | 'idle' | 'gone'
type Desk = {
  id: string
  label: string
  /** What the nameplate shows: `/office name <text>`, else the session's first prompt. */
  title: string
  cwd: string
  branch: string | null
  state: DeskState
  task: string
  activity: string
  report: string
  reportedAt: number | null
  /** The last HISTORY_KEEP finished turns, oldest first, so a report the next turn replaces can still be read. */
  history?: Array<{ at: number; task: string; report: string }>
  startedAt: number
  seenAt: number
  /** The `instructionAt` of the last page instruction this session ran. */
  instructionDoneAt: number | null
  /** The session's own process id, so the bridge can tell a dead session from a quiet one and can end one that does not answer. */
  pid: number | null
  /** The terminal the session runs in (`/dev/ttys012`), so 開除 can close its iTerm tab. */
  tty: string | null
  /** Set while the session waits on something only the person at the terminal can answer. */
  blocked: 'permission' | 'question' | 'dialog' | null
  /** Background work (subagents, shells, workflows) still running after the last turn: the colleague keeps working at its desk. */
  bg?: { n: number; kinds: string[] } | null
  /** The main loop's model and effort as of its last request: the page shows them. */
  model?: string | null
  effort?: string | null
  /** Whether the last page instruction (`at` = its `instructionAt`) reached the conversation: `sent` until its turn starts. */
  delivery?: { at: number; state: 'sent' | 'retried' | 'delivered' | 'failed'; reason?: string } | null
  /** The pending permission request (its settings hook's start, and the session id it runs under), so the page can answer it. */
  perm?: { at: number; sid: string } | null
  /** The slash command from the page whose terminal dialog nobody has answered (`/model`, …). */
  dialog?: string | null
  /** A model switch from the page in progress: the session restarts under the same id with `to` as its model. */
  switching?: { to: string; at: number } | null
  /** The project this desk belongs to: the name typed by the person, else the ticket key in the branch name, else the repo; none outside git. */
  project?: string | null
  projectBy?: 'manual' | 'ticket' | 'repo' | null
  /** The name typed with `/office project` (or given to a new session from the page), kept across a resume; empty means automatic. */
  projectManual?: string | null
  /** The project rolled up to its parent ticket (the bridge fills it from Jira); the board is kept per root. */
  projectRoot?: string | null
  /** Set when the last turn answered a teammate who came on its own (not one this session sent for): the desk does not call the person over. */
  relay?: string | null
  /** The questions of a pending AskUserQuestion, so the page can show the options and answer them. */
  ask: AskQuestion[] | null
  /** The context window's fill, as the status line shows it: the page draws it as the dog's health bar. */
  ctx?: { tokens: number | null; window: number; percent: number | null } | null
  /** What the session has cost so far, in USD. */
  cost?: number | null
  /** The account's rate-limit windows (five_hour, seven_day) as of `limitsAt`; shared by every session. */
  limits?: Array<{ kind: string; percentUsed: number; resetsAt?: string }> | null
  limitsAt?: number | null
}
type AskQuestion = { question: string; header: string; multiSelect: boolean; options: Array<{ label: string; description?: string }> }
type StoredDoc = { version?: number; data: Record<string, unknown> }

let home = ''
let me: Desk | null = null
let isBridge = false
let lastWriteAt = 0
let failureShown = false

const deskDir = () => `${home}/.claude/office/desks`
const inboxDir = () => `${home}/.claude/office/inbox`
const deskPath = (id: string) => `${deskDir()}/${id}.json`
// the project board: the bridge writes each desk's copy here, posts from a session wait in posts/
const boardsDir = () => `${home}/.claude/office/boards`
const boardFile = (id: string) => `${boardsDir()}/${id}.json`
const boardPostDir = () => `${boardsDir()}/posts`
const inboxPath = (id: string) => `${inboxDir()}/${id}.json`
// written and read by install/office-hook.sh, the settings hooks
const hookDir = () => `${home}/.claude/office/hook`

// What a /clear leaves on the desk: the conversation's task, title and report go.
const CLEARED: Partial<Desk> = { state: 'idle', task: '', title: '', report: '', reportedAt: null, blocked: null, ask: null, ctx: null, relay: null }
// A prompt the engine injected (a task notification, a system reminder, a
// local command's output) is not something the person asked for.
const isMetaPrompt = (text: string) => /^\s*</.test(text ?? '')

const firstLine = (text: string, max: number) => {
  const line = (text ?? '').split('\n').map(s => s.trim()).find(s => s.length > 0) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

function report($: EngineInterface, text: string) {
  $.ui.log(`office: ${text}`, { to: 'debug' })
  if (!failureShown) {
    failureShown = true
    $.ui.log(`office: ${text}`)
  }
}

async function branchOf($: EngineInterface, cwd: string) {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 })
    return exitCode === 0 ? stdout.trim() || null : null
  } catch {
    return null
  }
}

// ---- worker: the desk card as a file ---------------------------------------

// Context fill, cost and the account's rate limits, read at each turn's end and on the heartbeat.
// The limits are what this session's last API call saw, so `limitsAt` moves only when a
// turn just ended (`fresh`) or the numbers changed; an idle session must not look current.
async function refreshUsage($: EngineInterface, fresh = false) {
  if (!me) return
  try {
    const u = await $.session.usage()
    const tokens = typeof u.context.tokens === 'number' ? u.context.tokens : null
    const percent = typeof u.context.percent === 'number' ? u.context.percent
      : tokens !== null && u.context.window > 0 ? Math.round(tokens / u.context.window * 100) : null
    // before the first turn of a resumed process the engine knows no context yet: keep the last fill (a model switch resumes)
    if (tokens === null && me.ctx && me.ctx.tokens !== null) me.ctx = { ...me.ctx, window: u.context.window }
    else me.ctx = { tokens, window: u.context.window, percent }
    me.cost = u.cost ? Math.round(u.cost.usd * 100) / 100 : null
    if (u.rateLimits.length) {
      const limits = u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}) }))
      if (fresh || JSON.stringify(limits) !== JSON.stringify(me.limits ?? null)) me.limitsAt = Date.now()
      me.limits = limits
    }
  } catch (error) {
    report($, `usage could not be read: ${String(error)}`)
  }
}

async function saveDesk($: EngineInterface) {
  if (!me) return
  me.seenAt = Date.now()
  try {
    await $.fs.write(deskPath(me.id), JSON.stringify(me))
  } catch (error) {
    report($, `desk file could not be written: ${String(error)}`)
  }
}

// The project a desk belongs to, in this order: the name the person typed, the
// ticket key in the branch name (plain pattern, no Jira needed; the page rolls a
// child ticket up to its parent when Jira is configured), else the repo. A folder
// outside git gets none: its name (Documents, 桌面) is no project anyone meant.
const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/
async function repoOf($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    return exitCode === 0 ? basename(stdout.trim()) || null : null
  } catch { return null }
}
async function setProject($: EngineInterface) {
  if (!me) return
  const manual = (me.projectManual ?? '').trim()
  const ticket = TICKET_RE.exec(me.branch ?? '')?.[1] ?? null
  const repo = manual || ticket ? null : await repoOf($, me.cwd)
  const p: Partial<Desk> = manual ? { project: manual, projectBy: 'manual' }
    : ticket ? { project: ticket, projectBy: 'ticket' }
    : repo ? { project: repo, projectBy: 'repo' }
    : { project: null, projectBy: null }
  patch($, p)
}
const projectText = () => !me ? '' : me.project
  ? `專案「${me.project}」（${me.projectBy === 'manual' ? '你指定的' : me.projectBy === 'ticket' ? '分支票號' : 'repo'}）。`
  : '沒有專案：這個資料夾不在 git 裡，要跟別的 session 共用公佈欄就 `/office project <話題>` 指定一個。'

// The session's name as the engine last recorded it. A rename that took some other
// way than the command.run hook (the app's rename, one queued across a reload)
// still ends in the transcript, and the desk takes it from there.
let handingTitle: { title: string, at: number } | null = null   // a /rename the office queued (it waits for idle) and the engine has not run yet
async function sessionTitle($: EngineInterface): Promise<string> {
  if (!me || !/^[\w-]+$/.test(me.id)) return ''
  const ran = await $.process.run(['sh', '-c', `grep -h '"type":"custom-title"' "$HOME"/.claude/projects/*/${me.id}.jsonl | tail -1`], { timeoutMs: 5000 }).catch(() => null)
  try { return String(JSON.parse(ran?.stdout.trim() || '{}').customTitle ?? '').trim().slice(0, 60) } catch { return '' }
}

// turn.complete says only that an API error ended the turn; the engine's own words
// for it ("API Error: Your computer went to sleep mid-response…") are in the transcript
async function lastApiError($: EngineInterface): Promise<string> {
  if (!me || !/^[\w-]+$/.test(me.id)) return ''
  const ran = await $.process.run(['sh', '-c', `tail -n 40 "$HOME"/.claude/projects/*/${me.id}.jsonl | grep '"isApiErrorMessage":true' | tail -1`], { timeoutMs: 5000 }).catch(() => null)
  try {
    const content = JSON.parse(ran?.stdout.trim() || '{}').message?.content
    const text = Array.isArray(content) ? content.map((c: { text?: unknown }) => String(c.text ?? '')).join(' ') : String(content ?? '')
    return (text.replace(/^API Error:\s*/i, '').split('\n')[0] ?? '').trim().slice(0, 200)
  } catch { return '' }
}
const errorReport = (raw: string) => /went to sleep/i.test(raw)
  ? '_（這輪沒有文字回覆：電腦睡著，回覆中斷。傳「繼續」讓它接著做）_'
  : `_（這輪沒有文字回覆：API 錯誤${raw ? `：${raw}` : ''}）_`

function rename($: EngineInterface, title: string) {
  patch($, { title })
  if (title) void handTitle($, title)
}
// the session title follows the nameplate through the built-in /rename, which is
// what other sessions message it by; run from the clock, as a command cannot be
// run inside a hook the turn waits on (the rename tool's), and queued till idle
async function handTitle($: EngineInterface, title: string) {
  handingTitle = { title, at: Date.now() }
  $.clock.after(10, () => {
    $.command.run({ command: 'rename', args: title }).catch(error => report($, `/rename did not run: ${String(error)}`))
  })
}

// The terminal shows a permission dialog: the session stops until someone answers
// it there, so it walks to the office and says so. The settings hook leaves the
// request in a file; the tool.call hook clears the state once the call settles.
let permSeenAt = 0, permSettledAt = 0
const PERM_WAIT_MS = 11 * 60_000 // the settings hook gives up on the page after 10 minutes
async function checkPermission($: EngineInterface) {
  if (!me) return
  const sid = await $.session.id()
  const path = `${hookDir()}/perm-${sid}.json`
  try {
    // A request is over once the call settled (the settled file outlives a mod reload,
    // which resets permSeenAt / permSettledAt) or the hook stopped waiting (10 minutes).
    let settled = permSettledAt
    try { settled = Math.max(settled, Number(await $.fs.read(`${hookDir()}/settled-${sid}`)) || 0) } catch { /* none yet */ }
    const over = (at: number) => at <= settled || Date.now() - at > PERM_WAIT_MS
    // answered on the page: back to its desk to work, and it reports when the turn is done
    let answered = 0
    try { answered = Number(await $.fs.read(`${hookDir()}/answered-${sid}`)) || 0 } catch { /* none yet */ }
    if (me.blocked === 'permission' && me.perm && answered >= me.perm.at && !over(me.perm.at)) {
      patch($, { state: 'working', activity: '權限已處理，繼續', blocked: null, perm: null })
    }
    if (me.blocked === 'permission' && (!me.perm || over(me.perm.at))) {
      // stale: put back the last real report instead of the permission notice
      const last = me.history?.at(-1)
      patch($, { state: last ? 'reporting' : 'idle', activity: last ? '等你回覆' : '閒置', blocked: null, perm: null, report: last?.report ?? '', reportedAt: last?.at ?? null })
    }
    if (!(await $.fs.exists(path))) return
    const { at, event: e } = JSON.parse(await $.fs.read(path)) as { at?: number; event?: { agent_id?: string; tool_name?: string; tool_input?: Record<string, unknown> } }
    if (typeof at !== 'number' || at <= permSeenAt) return
    permSeenAt = at
    if (over(at) || answered >= at || !e || e.agent_id) return
    const what = describe({ tool: e.tool_name ?? '', ...(e.tool_input ?? {}) })
    const command = e.tool_input?.command
    const detail = typeof command === 'string' ? '\n\n```\n' + command.slice(0, 600) + '\n```' : ''
    patch($, { state: 'reporting', activity: '等你確認權限', blocked: 'permission', perm: { at, sid }, reportedAt: Date.now(), report: `### 等你確認權限\n\n${what}${detail}\n\n_在下面按允許或拒絕，或到它的 terminal 分頁回答。_` })
  } catch { /* half-written; next round */ }
}

// After a turn: background work still running means the colleague is waiting on
// it, not on you, so it stays at its desk as working, unless it asks you something.
const DECIDE_RE = /^#{1,3}\s*(要你決定|Decisions for you)\s*$/m
async function noteModel($: EngineInterface) {
  try { const model = await $.session.model(); if (me && model && model !== me.model) patch($, { model }) } catch { /* the next turn reports it */ }
}

async function checkBackground($: EngineInterface, turnAt: number) {
  if (!me || me.state !== 'reporting' || me.reportedAt !== turnAt || me.blocked || DECIDE_RE.test(me.report)) return
  const kinds: string[] = []
  try { for (const a of await $.agent.list()) if (a.status === 'running' || a.status === 'pending') kinds.push('subagent') } catch { /* none */ }
  try {
    const { at, event } = JSON.parse(await $.fs.read(`${hookDir()}/bg-${await $.session.id()}.json`)) as { at?: number; event?: { background_tasks?: Array<{ type?: string; status?: string; description?: string }> } }
    if (typeof at === 'number' && at >= turnAt - 10_000 && Array.isArray(event?.background_tasks)) {
      // publishing an artifact auto-arms a watch that stays for the whole session: not work being waited on
      const fromHook = event.background_tasks
        .filter(t => !t.status || /running|pending/i.test(t.status))
        .filter(t => !(t.type === 'monitor' && /^live updates for artifact\b/i.test(t.description ?? '')))
        .map(t => t.type || 'task')
      // the hook lists subagents too: prefer its list when it has one
      if (fromHook.length) kinds.splice(0, kinds.length, ...fromHook)
    }
  } catch { /* no Stop hook installed, or nothing written */ }
  if (!kinds.length || !me || me.reportedAt !== turnAt) return
  const NAMES: Record<string, string> = { subagent: '子代理', shell: '背景指令', workflow: 'workflow', monitor: '監看' }
  const named = [...new Set(kinds.map(k => NAMES[k] ?? k))]
  patch($, { state: 'working', activity: `等 ${kinds.length} 個背景工作（${named.join('、')}）`, bg: { n: kinds.length, kinds: [...new Set(kinds)] } })
}

function patch($: EngineInterface, p: Partial<Desk>, options: { throttle?: boolean } = {}) {
  if (!me) return
  Object.assign(me, p)
  const nowMs = Date.now()
  if (options.throttle && nowMs - lastWriteAt < ACTIVITY_WRITE_MIN_MS) return
  lastWriteAt = nowMs
  void saveDesk($)
}

// An instruction typed on the page arrives as inbox/<id>.json from the bridge.
// Hand it to the session once, as the person's own prompt.
// "開除" from the page: the desk goes offline (the bridge then drops it) and the
// session ends. The engine's own /exit is tried first; if it is not runnable
// from a plugin, the process ends itself (its pid is the parent of a child shell).
// This process's id: the parent of a child shell.
async function ownPid($: EngineInterface): Promise<number | null> {
  try {
    const out = (await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 5000 })).stdout.trim()
    return /^\d+$/.test(out) ? Number(out) : null
  } catch { return null }
}

async function ownTty($: EngineInterface): Promise<string | null> {
  try {
    const out = (await $.process.run(['sh', '-c', 'ps -o tty= -p $PPID'], { timeoutMs: 5000 })).stdout.trim()
    return /^tty\S+$/.test(out) ? `/dev/${out}` : null
  } catch { return null }
}

async function leaveOffice($: EngineInterface) {
  patch($, { state: 'gone', activity: '被辦公室開除，下線' })
  await saveDesk($)
  me = null
  try {
    await $.command.run({ command: 'exit', args: '' })
  } catch (error) {
    $.ui.log(`office: /exit failed (${String(error)}), ending the process instead`, { to: 'debug' })
    const pid = await ownPid($)
    if (pid) await $.process.run(['kill', '-TERM', String(pid)], { timeoutMs: 5000 })
  }
}

// Waits for the office to answer an open question: the page sends either
// `/answer {"<question>": "<label>"}` or plain text, which answers every question.
async function waitForAnswer($: EngineInterface, ask: AskQuestion[], signal: AbortSignal, done: () => boolean): Promise<Record<string, string> | null> {
  while (!done() && !signal.aborted && me) {
    try {
      const path = inboxPath(me.id)
      if (await $.fs.exists(path)) {
        const inbox = JSON.parse(await $.fs.read(path)) as { instruction?: unknown; instructionAt?: unknown }
        const text = typeof inbox.instruction === 'string' ? inbox.instruction.trim() : ''
        const at = typeof inbox.instructionAt === 'number' ? inbox.instructionAt : 0
        if (text && at > (me.instructionDoneAt ?? 0)) {
          me.instructionDoneAt = at
          if (text.startsWith('/answer ')) {
            const parsed = JSON.parse(text.slice(8)) as Record<string, unknown>
            const out: Record<string, string> = {}
            for (const q of ask) if (typeof parsed[q.question] === 'string') out[q.question] = parsed[q.question] as string
            if (Object.keys(out).length) return out
          } else if (!text.startsWith('/')) {
            return Object.fromEntries(ask.map(q => [q.question, text]))
          }
        }
      }
    } catch { /* half-written inbox; next round */ }
    try { await $.clock.sleep(1000, { signal }) } catch { return null }
  }
  return null
}

async function takeInstruction($: EngineInterface) {
  // mid-switch the process is on its way out: the resumed one takes the instruction
  if (!me || me.blocked === 'question' || switching) return
  const path = inboxPath(me.id)
  try {
    if (!(await $.fs.exists(path))) return
    const inbox = JSON.parse(await $.fs.read(path)) as { instruction?: unknown; instructionAt?: unknown }
    const instruction = typeof inbox.instruction === 'string' ? inbox.instruction.trim() : ''
    const at = typeof inbox.instructionAt === 'number' ? inbox.instructionAt : 0
    if (!instruction || !at || at <= (me.instructionDoneAt ?? 0)) return
    me.instructionDoneAt = at
    if (instruction.startsWith('/')) {
      // a slash command from the page (`/clear`, `/compact`, …) runs as if typed
      const [name = '', ...rest] = instruction.slice(1).split(/\s+/)
      if (!name) return
      if (name === 'exit' || name === 'quit') { await leaveOffice($); return }
      // our own command: $.command.run skips the plugin that calls it, so /office
      // sent from the page reached no hook and the nameplate never changed
      if (name === 'office') {
        if (rest[0] === 'name') rename($, rest.slice(1).join(' ').trim().slice(0, 60))
        else if (rest[0] === 'pause') await pause($)
        else if (rest[0] === 'model') await switchModel($, rest[1] ?? '')
        else if (rest[0] === 'project') { me.projectManual = rest.slice(1).join(' ').trim().slice(0, 60); await setProject($) }
        return
      }
      if (name === 'clear') patch($, { ...CLEARED, activity: '執行 /clear' })
      else patch($, { activity: `執行 /${name}` })
      if (name === 'model') pageModelSwitchAt = Date.now()
      // a command that opens a dialog in the terminal resolves only when the dialog is answered there;
      // /compact and /clear open none, but wait behind a running turn and /compact takes a while itself
      const stuck = name === 'compact' || name === 'clear' ? { cancel() {} } : $.clock.after(DIALOG_WAIT_MS, () => { if (me && !me.blocked) patch($, { state: 'reporting', activity: '卡在 terminal 的對話框', blocked: 'dialog', dialog: `/${name}`, reportedAt: Date.now() }) })
      const settingsBefore = name === 'effort' ? await readSettings($) : null
      try { await $.command.run({ command: name, args: rest.join(' ') }) }
      finally {
        stuck.cancel()
        if (me?.blocked === 'dialog') patch($, { state: 'idle', activity: '對話框已處理', blocked: null, dialog: null })
      }
      if (name === 'model') await noteModel($)
      if (name === 'effort') {
        await restoreEffortDefaults($, settingsBefore)
        // nothing reads the effort back until the next request; show the level asked for till then
        if (/^(low|medium|high|xhigh|max)$/.test(rest[0] ?? '')) patch($, { effort: rest[0], activity: `effort 改成 ${rest[0]}（只有這個 session）` })
      }
      return
    }
    patch($, { state: 'working', activity: '收到辦公室的指令', task: firstLine(instruction, 80) })
    await deliver($, { at, text: instruction, tries: 0, sentAt: 0 })
  } catch (error) {
    report($, `instruction from the office could not be run: ${String(error)}`)
  }
}

// /model from the page: the engine asks "Switch model?" in the terminal when the
// prompt cache is warm; nobody is there to answer, so the switch the page asked
// for is allowed through the PreModelSwitch hook instead.
let pageModelSwitchAt = 0
const DIALOG_WAIT_MS = 10_000

// "暫停" on the page: ends the running turn the way Esc does, but without the
// interruption marker, so the next page instruction still gets in.
let runningTurn: string | null = null
let turnFrom: string | null = null          // the teammate whose message started the running turn; null when the person did
const sentFor = new Set<string>()          // teammates this session messaged for the person: their replies are reported (kept until /clear)
let pausing = false

async function pause($: EngineInterface) {
  if (!runningTurn) { patch($, { state: 'idle', activity: '沒有在跑的工作，不用暫停' }); return }
  pausing = true
  try { await $.turn.abort({ turnId: runningTurn }) } catch (error) {
    pausing = false
    report($, `pause from the office failed: ${String(error)}`)
  }
}

// 換模型 from the page: switching mid-session makes the engine ask "Switch model?"
// in the terminal, which nobody is there to answer. So the session ends and a new
// tab resumes it under the same id with the model given at start, which asks nothing.
let switching = false
const SWITCH_GRACE_MS = 90_000

async function switchModel($: EngineInterface, arg: string) {
  if (!me) return
  if (!/^[\w.[\]-]+$/.test(arg)) { report($, `model switch from the office refused: bad model "${arg}"`); return }
  const { id, cwd, pid } = me
  if (!pid) { report($, 'model switch from the office refused: own pid unknown'); return }
  if (runningTurn) {
    pausing = true
    try { await $.turn.abort({ turnId: runningTurn }) } catch { /* already ending */ }
    for (let i = 0; i < 20 && runningTurn; i++) await $.clock.sleep(250)
  }
  switching = true
  // not 'working': the page gives a switching desk its own look
  patch($, { state: 'idle', activity: `換成 ${arg} 中：用新模型接回這段對話`, switching: { to: arg, at: Date.now() }, blocked: null, ask: null, bg: null, dialog: null })
  await saveDesk($)
  // the new tab waits for this process to end before resuming, so two processes never hold the session;
  // `; exit` closes the tab however the session later ends (see TAB_EXIT)
  const command = `cd ${shellQuote(cwd)} && while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done; claude --resume ${id} --model ${shellQuote(arg)}${TAB_EXIT}`
  const script = [
    'tell application "iTerm2"',
    '  if (count of windows) = 0 then',
    '    set w to (create window with default profile)',
    '  else',
    '    set w to current window',
    '    tell w to create tab with default profile',
    '  end if',
    `  tell current session of w to write text "${asQuote(command)}"`,
    'end tell',
  ].join('\n')
  const ran = await $.process.run(['osascript', '-e', script], { timeoutMs: 15_000 })
  if (ran.exitCode !== 0) {
    switching = false
    patch($, { state: 'idle', activity: '換模型失敗：開不了新的 terminal 分頁', switching: null })
    report($, `model switch: osascript failed: ${ran.stderr.trim().slice(0, 200)}`)
    return
  }
  try { await $.command.run({ command: 'exit', args: '' }) } catch {
    await $.process.run(['kill', '-TERM', String(pid)], { timeoutMs: 5000 })
  }
}

// A page instruction handed to the session is not yet in the conversation: the
// engine can refuse it (`drop`), and a prompt queued behind a running turn is
// thrown away when the person interrupts that turn. It counts as delivered once
// a turn starts with its text; otherwise it is sent once more, then marked failed.
let pendingInstruction: { at: number; text: string; tries: number; sentAt: number } | null = null
const DELIVERY_WAIT_MS = 15_000

async function deliver($: EngineInterface, p: { at: number; text: string; tries: number; sentAt: number }) {
  pendingInstruction = { ...p, tries: p.tries + 1, sentAt: Date.now() }
  patch($, { delivery: { at: p.at, state: p.tries ? 'retried' : 'sent' } })
  let reason = ''
  try {
    const r = await $.prompt.submit({ text: p.text, asUser: true })
    if (r.drop !== undefined) reason = r.drop || 'refused'
  } catch (error) { reason = String(error) }
  if (reason) report($, `instruction from the office did not enter: ${reason}`)
  if (reason && pendingInstruction?.at === p.at) {
    // after an interrupt the engine refuses outside prompts until someone types in the terminal, so a resend can't help
    const stopped = /session was stopped/i.test(reason)
    if (pendingInstruction.tries < 2 && !stopped) $.clock.after(3000, () => { if (pendingInstruction?.at === p.at) void deliver($, pendingInstruction) })
    else lost($, p.at, stopped ? STOPPED_REASON : firstLine(reason, 120))
  }
}

const STOPPED_REASON = '你在終端機中斷後，要先在它的 terminal 輸入一次，才收得到辦公室的指令'

function lost($: EngineInterface, at: number, reason: string) {
  pendingInstruction = null
  const p: Partial<Desk> = { delivery: { at, state: 'failed', reason } }
  // taking the instruction marked the desk working; with nothing running it should not look busy
  if (me?.state === 'working' && me.activity === '收到辦公室的指令') Object.assign(p, { state: 'idle', activity: '指令沒送到' })
  patch($, p)
}

// Every tick: a sent instruction whose turn never started while the session sat
// idle (or after its running turn ended) was lost.
async function checkDelivery($: EngineInterface) {
  const p = pendingInstruction
  if (!p || !me || Date.now() - p.sentAt < DELIVERY_WAIT_MS) return
  if (me.state === 'working' && !me.bg) return        // still queued behind a running turn
  if (p.tries < 2) { await deliver($, p); return }
  lost($, p.at, '沒有進到對話（可能在終端機中斷時被清掉）')
}

function describe(e: { tool: string } & Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (e.tool) {
    case 'Bash': return `Bash：${firstLine(s(e.description) || s(e.command), 60)}`
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': return `${e.tool} ${basename(s(e.file_path))}`
    case 'Grep': return `Grep ${s(e.pattern)}`
    case 'Glob': return `Glob ${s(e.pattern)}`
    case 'Agent': return `子代理：${firstLine(s(e.description), 50)}`
    case 'Skill': return `Skill ${s(e.skill)}`
    case 'WebFetch': case 'WebSearch': return `${e.tool} ${firstLine(s(e.url) || s(e.query), 50)}`
    default: return e.tool.startsWith('mcp__') ? e.tool.split('__').slice(1).join(' · ') : e.tool
  }
}

// ---- bridge: files <-> artifact database -------------------------------------

let toolReady = false
let busy = false
let lastTick = { at: 0, note: '還沒跑過' }
let tickCount = 0
const synced: Record<string, string> = {}
const askSince: Record<string, number> = {}
const inboxWritten: Record<string, number> = {}
const permRelayed: Record<string, number> = {}

async function ensureTool($: EngineInterface) {
  if (toolReady) return true
  const has = async () => (await $.tool.list()).some(t => t.name === 'ArtifactData')
  if (!(await has())) {
    try {
      await $.tool.call({ tool: 'ToolSearch', query: 'select:ArtifactData', max_results: 1 })
    } catch (error) {
      report($, `ToolSearch failed: ${String(error)}`)
      return false
    }
  }
  toolReady = await has()
  if (!toolReady) report($, 'ArtifactData tool is not available in this session')
  return toolReady
}

// The tool's printed text, wherever the call result carries it.
function textOf(result: unknown): string {
  const r = result as { text?: unknown; result?: unknown } | null
  if (typeof r?.text === 'string') return r.text
  if (typeof r?.result === 'string') return r.result
  const content = (r?.result as { content?: unknown })?.content
  if (Array.isArray(content)) return content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  return JSON.stringify(result).replace(/\\n/g, '\n').replace(/\\"/g, '"')
}

// The tool prints each document as one JSON line; a refused write prints no version.
function docsIn(result: unknown): StoredDoc[] {
  const text = textOf(result)
  const out: StoredDoc[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as { id?: string; version?: number; data?: Record<string, unknown> }
      if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.id === 'string') out.push({ version: parsed.version, data: { ...parsed.data, id: parsed.id } })
    } catch { /* not a document line */ }
  }
  return out
}
const wroteOk = (result: unknown) => /"version"\s*:\s*\d+|version \d+/.test(JSON.stringify(result))

// Images pasted on the page arrive as `attachments` documents holding base64,
// split in parts (a document holds at most 256KB): the desk lists each image as
// `<id>#<parts>`, stored at <id>-p0 … <id>-p<parts-1>. The bridge joins them into
// images/<id>.<ext>, deletes the documents, and the session's prompt names the files.
const ATTACHMENTS = 'attachments'
const imagesDir = () => `${home}/.claude/office/images`
async function saveImages($: EngineInterface, refs: string[]): Promise<string[]> {
  const out: string[] = []
  await $.process.run(['mkdir', '-p', imagesDir()])
  for (const ref of refs) {
    const [docId = '', n = '1'] = ref.split('#')
    try {
      let b64 = '', mime: unknown = null
      const got: { id: string; version?: number }[] = []
      for (let k = 0; k < Number(n); k++) {
        const partId = `${docId}-p${k}`
        const doc = docsIn(await $.tool.call({ tool: 'ArtifactData', action: 'get', url: OFFICE_URL, collection: ATTACHMENTS, doc_id: partId }))[0]
        if (typeof doc?.data.b64 !== 'string') throw new Error(`part ${k} missing`)
        b64 += doc.data.b64; mime = doc.data.mime
        got.push({ id: partId, version: doc.version })
      }
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg'
      const path = `${imagesDir()}/${docId}.${ext}`
      await $.process.run(['base64', '-D', '-o', path], { stdin: b64, timeoutMs: 15_000 })
      out.push(path)
      for (const g of got) await $.tool.call({ tool: 'ArtifactData', action: 'delete', url: OFFICE_URL, collection: ATTACHMENTS, doc_id: g.id, ...(typeof g.version === 'number' ? { if_version: g.version } : {}) })
    } catch (error) {
      report($, `image ${docId} could not be saved: ${String(error)}`)
    }
  }
  return out
}

// A "新開 session" form on the page writes a document into `requests`. The
// bridge opens a new iTerm tab in that folder running `claude`, with the first
// task as the opening prompt and the desk title passed through the environment.
const REQUESTS = 'requests'
const BOARDS = 'boards'
const BOARD_KEEP = 50
/** One card per member: `desk` is the session that wrote it (none: the person, from the page); a new post by the
 *  same member replaces the card (the old one is archived, not deleted); `archived`: when it was replaced, or the desk left. */
type Note = { id: string; at: number; by: string; text: string; desk?: string; user?: boolean; topic?: string; archived?: number }
const activeNotes = (notes: Note[]) => notes.filter(n => !n.archived)
/** Every active note, and the last BOARD_KEEP archived ones, oldest first. */
const trimNotes = (notes: Note[]) => [...activeNotes(notes), ...notes.filter(n => n.archived).slice(-BOARD_KEEP)].sort((a, b) => a.at - b.at)
// same hash as the page's, so both sides name a project's board document alike
const fnv = (s: string) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) }
const boardId = (project: string) => 'b' + fnv(project)
let jiraParent: Record<string, string> = {}
const rootOf = (project: string | null | undefined) => project ? (jiraParent[project] ?? project) : null
const boardsWritten: Record<string, string> = {}
async function writeBoard($: EngineInterface, root: string, b: { version?: number; notes: Note[] }): Promise<boolean> {
  const data = { project: root, notes: b.notes }
  const wrote = b.version === undefined
    ? await $.tool.call({ tool: 'ArtifactData', action: 'set', url: OFFICE_URL, collection: BOARDS, doc_id: boardId(root), data })
    : await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OFFICE_URL, collection: BOARDS, doc_id: boardId(root), data, if_version: b.version })
  if (!wroteOk(wrote)) { report($, `board for ${root} not written: ${JSON.stringify(wrote).slice(0, 160)}`); return false }
  const m = /"version"\s*:\s*(\d+)|version (\d+)/.exec(JSON.stringify(wrote))
  b.version = Number(m?.[1] ?? m?.[2])
  return true
}

// Each desk gets a file with its project's board; a post by a session replaces
// that session's card on the board document, and a desk that left the project
// (or the office) has its card archived. One list of the collection per round.
async function syncBoards($: EngineInterface, desks: Desk[]) {
  const roots = new Map<string, string>()
  for (const d of desks) { const r = rootOf(d.project); if (r) roots.set(d.id, r) }
  // a desk that left its project (the name cleared, or /office project to none) loses its board file
  for (const d of desks) if (!roots.has(d.id) && boardsWritten[d.id] !== undefined) { await $.process.run(['rm', '-f', boardFile(d.id)], { timeoutMs: 5000 }); delete boardsWritten[d.id] }
  if (!roots.size) return
  const boards: Record<string, { version?: number; notes: Note[] }> = {}
  for (const doc of docsIn(await $.tool.call({ tool: 'ArtifactData', action: 'list', url: OFFICE_URL, collection: BOARDS, query: { limit: 200 } }))) {
    if (typeof doc.data.project === 'string') boards[doc.data.project] = { version: doc.version, notes: Array.isArray(doc.data.notes) ? (doc.data.notes as Note[]) : [] }
  }
  let posts: string[] = []
  try { posts = (await $.process.run(['ls', boardPostDir()], { timeoutMs: 5000 })).stdout.split('\n').filter(f => f.endsWith('.json')) } catch { /* no posts yet */ }
  for (const f of posts) {
    const path = `${boardPostDir()}/${f}`
    try {
      const post = JSON.parse(await $.fs.read(path)) as { desk: string; by: string; text: string; at: number }
      const root = roots.get(post.desk)
      if (root) {
        const b = boards[root] ?? { notes: [] }
        const note: Note = { id: post.at.toString(36), at: post.at, by: post.by, text: post.text, desk: post.desk }
        // also a card from before cards carried the desk id, told by the same name
        b.notes = trimNotes([...b.notes.map(n => !n.archived && (n.desk === post.desk || (!n.desk && !n.user && n.by === post.by)) ? { ...n, archived: post.at } : n), note])
        if (!(await writeBoard($, root, b))) continue   // the file waits for the next round
        boards[root] = b
      }
      await $.process.run(['rm', '-f', path], { timeoutMs: 5000 })
    } catch { /* half-written; next round */ }
  }
  // a member that is no longer on the project (left it, or the office) takes its card down
  const members = new Set<string>()
  for (const [deskId, root] of roots) members.add(`${root}\n${deskId}`)
  for (const [root, b] of Object.entries(boards)) {
    const gone = b.notes.filter(n => !n.archived && n.desk && !members.has(`${root}\n${n.desk}`))
    if (!gone.length) continue
    const at = Date.now()
    b.notes = trimNotes(b.notes.map(n => gone.includes(n) ? { ...n, archived: at } : n))
    await writeBoard($, root, b)
  }
  for (const [deskId, root] of roots) {
    const body = JSON.stringify({ project: root, notes: boards[root]?.notes ?? [] })
    if (boardsWritten[deskId] === body) continue
    await $.fs.write(boardFile(deskId), body)
    boardsWritten[deskId] = body
  }
}

const BOARD_CONTEXT = (b: { project: string; notes: Note[] }, includeArchived = false) => {
  const when = (t: number) => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const line = (n: Note) => `- [${when(n.at)} ${n.by}] ${n.text}`
  const active = activeNotes(b.notes), archived = b.notes.filter(n => n.archived)
  const head = `# 專案公佈欄「${b.project}」（Session Office）\n每位成員一張卡：同專案每個 session 和使用者各一則，寫的是那位目前的狀態或要大家知道的事。跟你的工作有關的要照著做或避開：\n`
  const tail = `\n你的卡用 office 的 board 工具更新（action: post 會換掉你上一則）：你改了共用的東西、進度有變、在等某位同事、或接手的人要知道的事時就更新。
跟同專案 session 有關的技術協調（介面長怎樣、共用檔誰改、命名、誰先誰後）先用傳訊問那個 session 或更新你的卡，彼此談好再動手，不要丟給使用者；只有範圍、優先順序、開工、開／關／合併 MR、刪東西這類破壞性操作、花錢、或兩邊談不攏的事，才放進「要你決定」問使用者。`
  const arc = includeArchived && archived.length ? `\n封存（被新的卡換掉，或那位已離開；只供追查）：\n${archived.map(line).join('\n')}` : ''
  return head + (active.length ? active.map(line).join('\n') : '（目前沒有人貼卡）') + arc + tail
}
// `/effort <level>` also saves the level as the default for new sessions, in
// settings.json (top-level `effortLevel`, and per model under `modelSettings`).
// A pick on the page means this session only, so the defaults are put back
// afterwards; the running session keeps its level, which lives in memory.
const settingsPath = () => `${home}/.claude/settings.json`
type Json = Record<string, any>
async function readSettings($: EngineInterface): Promise<Json | null> {
  try { return JSON.parse(await $.fs.read(settingsPath())) as Json } catch { return null }
}
const effortDefaults = (s: Json) => JSON.stringify([s.effortLevel ?? null, Object.entries((s.modelSettings ?? {}) as Json).map(([m, v]) => [m, (v as Json)?.effortLevel ?? null])])
async function restoreEffortDefaults($: EngineInterface, before: Json | null) {
  if (!before) return
  const after = await readSettings($)
  if (!after || effortDefaults(before) === effortDefaults(after)) return
  if (before.effortLevel === undefined) delete after.effortLevel
  else after.effortLevel = before.effortLevel
  const models: Json = { ...(after.modelSettings ?? {}) }
  const wasModels: Json = before.modelSettings ?? {}
  for (const m of new Set([...Object.keys(models), ...Object.keys(wasModels)])) {
    const was = wasModels[m]?.effortLevel
    if (was !== undefined) { models[m] = { ...(models[m] ?? {}), effortLevel: was }; continue }
    const rest: Json = { ...(models[m] ?? {}) }
    delete rest.effortLevel
    if (Object.keys(rest).length) models[m] = rest
    else delete models[m]
  }
  if (Object.keys(models).length) after.modelSettings = models
  else delete after.modelSettings
  await $.fs.write(settingsPath(), JSON.stringify(after, null, 2) + '\n')
}
const requested = new Set<string>()
// A tab the office opens ends with its session: closing it only on 開除 or a model
// switch left a bare shell behind after /exit typed, Ctrl+C or a crash.
const TAB_EXIT = '; exit'
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const asQuote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

async function openRequestedSessions($: EngineInterface) {
  const found = await $.tool.call({ tool: 'ArtifactData', action: 'query', url: OFFICE_URL, collection: REQUESTS, query: { where: [['status', '==', 'pending']], limit: 20 } })
  for (const doc of docsIn(found)) {
    const id = String(doc.data.id)
    if (requested.has(id)) continue
    requested.add(id)
    const cwd = typeof doc.data.cwd === 'string' ? doc.data.cwd.trim() : ''
    const task = typeof doc.data.task === 'string' ? doc.data.task.trim() : ''
    const title = typeof doc.data.title === 'string' ? doc.data.title.trim() : ''
    const project = typeof doc.data.project === 'string' ? doc.data.project.trim().slice(0, 60) : ''
    const mark = async (status: string, extra: Record<string, unknown> = {}) => {
      await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OFFICE_URL, collection: REQUESTS, doc_id: id, data: { status, ...extra }, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
    }
    let isDir = false
    try { isDir = (await $.fs.stat(cwd)).kind === 'dir' } catch { isDir = false }
    if (!cwd || !isDir) { await mark('failed', { error: `目錄不存在：${cwd || '(空)'}` }); continue }
    // kind 'codex': Codex takes over from a handoff, with its first message as the task
    const command = (doc.data.kind === 'codex'
      ? `cd ${shellQuote(cwd)} && codex ${shellQuote(task)}`
      : `cd ${shellQuote(cwd)} && CLAUDE_OFFICE_TITLE=${shellQuote(title)} CLAUDE_OFFICE_PROJECT=${shellQuote(project)} claude${task ? ' ' + shellQuote(task) : ''}`) + TAB_EXIT
    const script = [
      'tell application "iTerm2"',
      '  if (count of windows) = 0 then',
      '    set w to (create window with default profile)',
      '  else',
      '    set w to current window',
      '    tell w to create tab with default profile',
      '  end if',
      `  tell current session of w to write text "${asQuote(command)}"`,
      'end tell',
    ].join('\n')
    try {
      const ran = await $.process.run(['osascript', '-e', script], { timeoutMs: 15000 })
      if (ran.exitCode === 0) await mark('started', { startedAt: Date.now() })
      else await mark('failed', { error: ran.stderr.trim().slice(0, 300) || `osascript exit ${ran.exitCode}` })
    } catch (error) {
      await mark('failed', { error: String(error).slice(0, 300) })
    }
  }
}

// The page shows a warning when this heartbeat goes stale: no bridge, no updates.
// Writes one document of `meta`, pinned to the version we last saw so two
// bridges cannot clobber each other; a refused write re-reads the doc and retries once.
const metaVersions: Record<string, number | undefined> = {}
async function putMeta($: EngineInterface, docId: string, data: Record<string, unknown>) {
  const write = async () => {
    const v = metaVersions[docId]
    return $.tool.call({ tool: 'ArtifactData', action: v === undefined ? 'set' : 'update', url: OFFICE_URL, collection: 'meta', doc_id: docId, data, ...(v !== undefined ? { if_version: v } : {}) })
  }
  let wrote = await write()
  if (!wroteOk(wrote)) {
    const got = docsIn(await $.tool.call({ tool: 'ArtifactData', action: 'get', url: OFFICE_URL, collection: 'meta', doc_id: docId }))
    metaVersions[docId] = got[0]?.version
    wrote = await write()
  }
  const v = /version (\d+)|"version"\s*:\s*(\d+)/.exec(JSON.stringify(wrote))
  if (v) metaVersions[docId] = Number(v[1] ?? v[2])
  return wroteOk(wrote)
}

async function heartbeat($: EngineInterface) {
  await putMeta($, 'bridge', { seenAt: Date.now(), sessionId: await $.session.id() })
  // what the page needs from the config (never the Jira email or token)
  const pub = JSON.stringify({ jiraSite: cfg.jira?.site ?? null, codex: cfg.codex !== false, tutor: cfg.tutor !== false, city: cfg.city ?? null, newSessionDirs: (cfg.newSessionDirs ?? []).map(d => d.replace(/^~(?=\/|$)/, home)) })
  if (pub !== configPublished && (await putMeta($, 'config', JSON.parse(pub)))) configPublished = pub
}
let configPublished = ''

async function loadConfig($: EngineInterface) {
  try { cfg = JSON.parse(await $.fs.read(`${home}/.claude/office/config.json`)) as OfficeConfig } catch { cfg = {} }
  OFFICE_URL = cfg.officeUrl ?? ''
}

// Jira: the bridge fetches the tickets assigned to the viewer and publishes
// them as meta/jira for the page's right-hand column. The API token stays in
// ~/.jira_api_token and reaches curl through a config on stdin, never argv.
const JIRA_EVERY = 24                       // every 24th tick: 2 minutes
const JIRA_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
type JiraIssue = { key: string; summary: string; status: string; category: string; type: string; priority: string | null; updated: number; parent: string | null; project: string }
let jiraNote = '還沒抓過'

async function fetchJira($: EngineInterface): Promise<JiraIssue[] | null> {
  const jira = cfg.jira
  if (!jira) { jiraNote = 'config.json 沒有 jira'; return null }
  const tokenPath = (jira.tokenFile ?? '~/.jira_api_token').replace(/^~(?=\/)/, home)
  if (!(await $.fs.exists(tokenPath))) { jiraNote = `沒有 ${jira.tokenFile ?? '~/.jira_api_token'}`; return null }
  const token = (await $.fs.read(tokenPath)).trim()
  const query = new URLSearchParams({ jql: jira.jql ?? JIRA_JQL, fields: 'summary,status,issuetype,priority,updated,parent,project', maxResults: '50' })
  const config = [`user = "${jira.email}:${token}"`, `url = "${jira.site}/rest/api/3/search/jql?${query}"`, 'silent', 'show-error', 'max-time = 20', 'header = "Accept: application/json"'].join('\n') + '\n'
  const ran = await $.process.run(['curl', '-K', '-'], { stdin: config, timeoutMs: 25_000 })
  if (ran.exitCode !== 0) { jiraNote = `curl 失敗（exit ${ran.exitCode}）：${ran.stderr.trim().slice(0, 200)}`; return null }
  let parsed: { issues?: Array<{ key: string; fields: Record<string, any> }>; errorMessages?: string[] }
  try { parsed = JSON.parse(ran.stdout) } catch { jiraNote = `Jira 回的不是 JSON：${ran.stdout.slice(0, 120)}`; return null }
  if (!Array.isArray(parsed.issues)) { jiraNote = `Jira 回錯：${(parsed.errorMessages ?? []).join('；').slice(0, 200) || ran.stdout.slice(0, 120)}`; return null }
  return parsed.issues.map(i => ({
    key: i.key,
    summary: String(i.fields.summary ?? ''),
    status: String(i.fields.status?.name ?? ''),
    category: String(i.fields.status?.statusCategory?.key ?? ''),
    type: String(i.fields.issuetype?.name ?? ''),
    priority: i.fields.priority?.name ?? null,
    updated: Date.parse(i.fields.updated) || 0,
    parent: i.fields.parent?.key ?? null,
    project: String(i.fields.project?.key ?? ''),
  }))
}

async function syncJira($: EngineInterface) {
  if (!cfg.jira) return
  try {
    const issues = await fetchJira($)
    if (!issues) { report($, `Jira: ${jiraNote}`); return }
    const parents: Record<string, string> = {}
    for (const i of issues) if (i.parent) parents[i.key] = i.parent
    jiraParent = parents
    const ok = await putMeta($, 'jira', { fetchedAt: Date.now(), site: cfg.jira.site, jql: cfg.jira.jql ?? JIRA_JQL, issues })
    jiraNote = ok ? `${issues.length} 張票，${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 更新` : '寫入 meta/jira 失敗'
  } catch (error) {
    jiraNote = `失敗：${String(error).slice(0, 200)}`
    report($, `Jira: ${jiraNote}`)
  }
}

// The heading follows `language` in config.json ("zh-TW" by default, or "en"); the page reads both.
const DECIDE_HEADING = () => (cfg.language === 'en' ? 'Decisions for you' : '要你決定')
// A message from another session comes in as `<cross-session-message from-name="…">`.
// The session the person gave the work to reports to them; a teammate it
// messages (or one that comes on its own) answers that session instead.
const TEAMMATE_RE = /<cross-session-message\b[^>]*\bfrom-name="([^"]*)"[^>]*>\s*([\s\S]*)/
const teammateOf = (text: string) => { const m = TEAMMATE_RE.exec(text ?? ''); return m?.[1] ? { name: m[1], body: m[2] ?? '' } : null }
const RELAY_CONTEXT = (name: string) => `# Who you answer to (Session Office)\nThis message is from the teammate session "${name}", not from the user. Do what it asks, then send your answer back to "${name}" with SendMessage. The text you end this turn with is not shown to the user as a report, so it should not be the only place the answer lives. Add a \`## ${DECIDE_HEADING()}\` section only for what the user must approve in person in this session (opening, closing or merging an MR, a destructive step, spending money, a permission); that is the only thing that calls the user over.`
const COMMANDER_CONTEXT = (name: string) => `# Who you answer to (Session Office)\nThis is a reply from "${name}", a teammate you sent work to on the user's behalf. You report to the user: put the teammates' answers together for them, and say who you are still waiting on, if anyone.`
const REPORT_FORMAT = () => `# Report format (Session Office)\nWhen a reply has anything the user must decide or answer, collect all of it in a final section headed exactly \`## ${DECIDE_HEADING()}\`: one line per item with the question, the options and your recommendation, at most 3 items. Do not leave such questions in the conclusion or the details, and put nothing after this section. Leave the heading out when there is nothing to decide. The Session Office page finds this heading to show the decisions as their own highlighted block.`

// Codex: every Codex call logs the account's limits in its rollout file
// (~/.codex/sessions/**/rollout-*.jsonl, a token_count event). The bridge
// publishes the latest one as meta/codex for the Codex coworker on the page.
// A rollout file written in the last two minutes means Codex is running (`working`).
const CODEX_EVERY = 12                      // every 12th tick: 1 minute
const CODEX_ACTIVE = `find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -120s 2>/dev/null | head -1`
const CODEX_LATEST = `for f in $(ls -t $(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -8 2>/dev/null) 2>/dev/null | head -5); do l=$(grep '"rate_limits"' "$f" | tail -1); [ -n "$l" ] && { printf '%s' "$l"; exit 0; }; done`
let codexLast = '', codexLimits: Record<string, unknown> | null = null

// every other tick for `working`; the limits only on `full` ticks or when `working` flips
async function syncCodex($: EngineInterface, full: boolean) {
  if (cfg.codex === false) return
  try {
    const active = await $.process.run(['sh', '-c', CODEX_ACTIVE], { timeoutMs: 10_000 })
    const working = !!active.stdout.trim()
    if (full || !codexLimits || working !== (JSON.parse(codexLast || '{}').working ?? false)) {
      const ran = await $.process.run(['sh', '-c', CODEX_LATEST], { timeoutMs: 10_000 })
      const line = ran.stdout.trim() ? JSON.parse(ran.stdout) as { timestamp?: string; payload?: { rate_limits?: Record<string, any> } } : null
      const rl = line?.payload?.rate_limits
      const win = (w: any) => w && typeof w.used_percent === 'number' ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes ?? null, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null } : null
      if (rl) codexLimits = { primary: win(rl.primary), secondary: win(rl.secondary), at: Date.parse(line?.timestamp ?? '') || null }
    }
    if (!codexLimits) return
    const data = { ...codexLimits, working }
    const key = JSON.stringify(data)
    if (key === codexLast) return
    if (await putMeta($, 'codex', { ...data, fetchedAt: Date.now() })) codexLast = key
  } catch (error) {
    report($, `Codex: ${String(error).slice(0, 200)}`)
  }
}

// Seats: the bridge hands each session a fixed seat number (lowest free one),
// kept across bridge restarts in the store, so a dog never changes desk while
// others come and go. The number rides on the desk document as `seat`.
let seats: Record<string, number> | null = null
let seatsWritten = ''
async function assignSeats($: EngineInterface, liveIds: string[]) {
  if (!seats) seats = ((await $.store.get('seats')) as Record<string, number> | undefined) ?? {}
  let changed = false
  for (const id of Object.keys(seats)) if (!liveIds.includes(id)) { delete seats[id]; changed = true }
  const taken = new Set(Object.values(seats))
  for (const id of liveIds) {
    if (seats[id]) continue
    let n = 1
    while (taken.has(n)) n++
    seats[id] = n; taken.add(n); changed = true
  }
  if (changed) await $.store.set('seats', seats)
  return seats
}

const processAlive = async ($: EngineInterface, pid: number) => (await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 5000 })).exitCode === 0

// An /exit from the page that the session has not acted on within this long
// is carried out by the bridge: end the process (when its pid is known) and
// drop the desk, so 開除 works on a stuck or outdated session too.
const EXIT_GRACE_MS = 15_000

// Closes the iTerm2 tab (session) running on that tty, once its process is gone.
const CLOSE_TAB_SCRIPT = `on run argv
  set wanted to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is wanted then
            close s
            return "closed"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`
async function closeTerminal($: EngineInterface, tty: string, pid: number | null) {
  try {
    // give the process up to 4 s to end, so iTerm does not ask about a running job
    if (pid) await $.process.run(['sh', '-c', `for i in 1 2 3 4 5 6 7 8; do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.5; done`], { timeoutMs: 10_000 })
    const ran = await $.process.run(['osascript', '-e', CLOSE_TAB_SCRIPT, tty], { timeoutMs: 15_000 })
    $.ui.log(`office: close tab ${tty}: ${ran.stdout.trim() || ran.stderr.trim()}`, { to: 'debug' })
  } catch (error) {
    report($, `could not close the terminal tab ${tty}: ${String(error)}`)
  }
}

async function bridgeTick($: EngineInterface) {
  if (busy) { lastTick.note = `上一輪還沒結束（${Math.round((Date.now() - lastTick.at) / 1000)} 秒），可能卡在權限視窗`; return }
  busy = true
  tickCount += 1
  lastTick = { at: Date.now(), note: '載入 ArtifactData 工具' }
  try {
    if (!OFFICE_URL) { lastTick.note = '~/.claude/office/config.json 沒有 officeUrl'; return }
    if (!(await ensureTool($))) { lastTick.note = 'ArtifactData 工具載不進來'; return }
    if (tickCount % 2 === 1) await heartbeat($)
    if (tickCount === 2 || tickCount % JIRA_EVERY === 0) { lastTick.note = '抓 Jira'; await syncJira($) }
    if (tickCount === 3 || tickCount % 2 === 0) await syncCodex($, tickCount === 3 || tickCount % CODEX_EVERY === 0)
    if (tickCount % (JIRA_EVERY * 30) === 0) await $.process.run(['find', imagesDir(), '-type', 'f', '-mtime', '+7', '-delete']).catch(() => {})
    lastTick.note = '讀資料庫'
    const listResult = await $.tool.call({ tool: 'ArtifactData', action: 'list', url: OFFICE_URL, collection: COLLECTION, query: { limit: 200 } })
    const listed = docsIn(listResult)
    if (listed.length === 0 && /deny|refused|error/i.test(textOf(listResult))) {
      lastTick.note = `list 被拒：${textOf(listResult).slice(0, 200)}`
      report($, lastTick.note)
      return
    }
    const docs = new Map(listed.map(d => [String(d.data.id), d]))
    lastTick.note = `資料庫 ${docs.size} 筆，讀桌卡檔`

    const files = new Map<string, Desk>()
    const entries = await $.fs.list(deskDir()).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      try {
        const desk = JSON.parse(await $.fs.read(`${deskDir()}/${entry.name}`)) as Desk
        if (desk && typeof desk.id === 'string') files.set(desk.id, desk)
      } catch { /* half-written file; next tick */ }
    }

    const nowMs = Date.now()
    // a desk whose process is dead is gone, however fresh its file looks
    const dead = new Set<string>()
    const midSwitch = (d: Desk) => !!d.switching && nowMs - d.switching.at < SWITCH_GRACE_MS
    for (const [id, desk] of files) if (typeof desk.pid === 'number' && desk.state !== 'gone' && !midSwitch(desk) && !(await processAlive($, desk.pid))) dead.add(id)
    // one process, two desks: the session took a new id (e.g. /resume) and wrote a
    // new desk, so the older one is retired and a reply still waiting in its inbox
    // moves to the desk that process answers now
    const byPid = new Map<number, Desk[]>()
    for (const desk of files.values()) if (typeof desk.pid === 'number' && desk.state !== 'gone' && !dead.has(desk.id)) byPid.set(desk.pid, [...(byPid.get(desk.pid) ?? []), desk])
    for (const desks of byPid.values()) {
      if (desks.length < 2) continue
      const current = desks.reduce((a, b) => (b.seenAt > a.seenAt ? b : a))
      for (const old of desks) {
        if (old === current) continue
        dead.add(old.id)
        if ((await $.fs.exists(inboxPath(old.id))) && !(await $.fs.exists(inboxPath(current.id))))
          await $.process.run(['mv', inboxPath(old.id), inboxPath(current.id)])
      }
    }
    // an /exit the session did not carry out in time: the bridge ends it
    for (const [id, doc] of docs) {
      const desk = files.get(id)
      const at = typeof doc.data.instructionAt === 'number' ? doc.data.instructionAt : 0
      const done = typeof doc.data.instructionDoneAt === 'number' ? doc.data.instructionDoneAt : 0
      if (!desk || doc.data.instruction !== '/exit' || at <= done || nowMs - at < EXIT_GRACE_MS) continue
      if (typeof desk.pid === 'number' && (await processAlive($, desk.pid))) await $.process.run(['kill', '-TERM', String(desk.pid)], { timeoutMs: 5000 })
      dead.add(id)
    }
    // an old file only means a dead session when there is no process to ask: a
    // live pid keeps its desk (and seat) however long the Mac slept
    const stale = (d: Desk) => typeof d.pid !== 'number' && nowMs - d.seenAt > STALE_MS
    const live = [...files.values()].filter(d => d.state !== 'gone' && !dead.has(d.id) && !stale(d)).map(d => d.id)
    const seatOf = await assignSeats($, live)
    // the same seat table on disk, so a session can tell which desk is which
    const seatTable = live.map(id => ({ seat: seatOf[id], id, title: files.get(id)?.title || files.get(id)?.label || '', pid: files.get(id)?.pid ?? null })).sort((x, y) => (x.seat ?? 0) - (y.seat ?? 0))
    const seatBody = JSON.stringify(seatTable, null, 1)
    if (seatBody !== seatsWritten) { await $.fs.write(`${home}/.claude/office/seats.json`, seatBody); seatsWritten = seatBody }
    for (const [id, desk] of files) {
      const doc = docs.get(id)
      if (desk.state === 'gone' || dead.has(id) || stale(desk)) {
        // a session 開除'd from the page also loses its terminal tab
        if (doc?.data.instruction === '/exit' && typeof desk.tty === 'string') await closeTerminal($, desk.tty, typeof desk.pid === 'number' ? desk.pid : null)
        if (doc) await $.tool.call({ tool: 'ArtifactData', action: 'delete', url: OFFICE_URL, collection: COLLECTION, doc_id: id, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
        await $.process.run(['rm', '-f', deskPath(id), inboxPath(id), boardFile(id)])
        delete boardsWritten[id]
        delete synced[id]
        delete inboxWritten[id]
        continue
      }
      const data: Record<string, unknown> = { ...desk, seat: seatOf[id], projectRoot: rootOf(desk.project) }
      // a session on an older mod that is inside AskUserQuestion: its tool.call
      // hook only wrote the tool's name as activity, so flag the wait from here
      if (desk.state === 'working' && desk.activity === 'AskUserQuestion' && !desk.blocked) {
        askSince[id] ??= nowMs
        Object.assign(data, { state: 'reporting', blocked: 'question', activity: '等你選擇', reportedAt: askSince[id], report: '### 需要你決定\n\n這個 session 在 terminal 問你問題（它還在用舊版 mod，這裡看不到題目）。\n\n_請切到它的 terminal 分頁作答。_' })
      } else delete askSince[id]
      const body = JSON.stringify(data)
      if (doc && synced[id] === body) continue
      delete data.id
      const wrote = doc
        ? await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OFFICE_URL, collection: COLLECTION, doc_id: id, data, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
        : await $.tool.call({ tool: 'ArtifactData', action: 'set', url: OFFICE_URL, collection: COLLECTION, doc_id: id, data })
      if (wroteOk(wrote)) synced[id] = body
      else report($, `desk ${desk.title || desk.label} could not be synced: ${JSON.stringify(wrote).slice(0, 200)}`)
    }

    try { await syncBoards($, live.map(id => files.get(id)!).filter(Boolean)) } catch (error) { report($, `boards: ${String(error).slice(0, 200)}`) }
    await openRequestedSessions($)

    for (const [id, doc] of docs) {
      if (!files.has(id)) {
        await $.tool.call({ tool: 'ArtifactData', action: 'delete', url: OFFICE_URL, collection: COLLECTION, doc_id: id, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
        continue
      }
      const instruction = typeof doc.data.instruction === 'string' ? doc.data.instruction : ''
      const at = typeof doc.data.instructionAt === 'number' ? doc.data.instructionAt : 0
      const done = typeof doc.data.instructionDoneAt === 'number' ? doc.data.instructionDoneAt : 0
      if (instruction && at > done && inboxWritten[id] !== at) {
        const images = Array.isArray(doc.data.images) ? doc.data.images.filter((x): x is string => typeof x === 'string') : []
        const paths = images.length ? await saveImages($, images) : []
        const text = paths.length ? `${instruction}\n\n（附圖已存在本機，請用 Read 讀取）\n${paths.map(p => `- ${p}`).join('\n')}` : instruction
        await $.fs.write(inboxPath(id), JSON.stringify({ instruction: text, instructionAt: at }))
        inboxWritten[id] = at
      }
      // 允許 / 拒絕 pressed on the page: hand it to the settings hook waiting on that request
      const answer = doc.data.permAnswer, answerAt = doc.data.permAnswerAt, perm = files.get(id)?.perm
      if ((answer === 'allow' || answer === 'deny') && typeof answerAt === 'number' && permRelayed[id] !== answerAt && perm && doc.data.permFor === perm.at) {
        await $.fs.write(`${hookDir()}/answer-${perm.sid}.json`, JSON.stringify({ behavior: answer, for: perm.at }))
        permRelayed[id] = answerAt
      }
    }
    lastTick.note = `第 ${tickCount} 輪完成：資料庫 ${docs.size} 筆、桌卡檔 ${files.size} 個、已同步 ${Object.keys(synced).length} 個`
  } catch (error) {
    lastTick.note = `失敗：${String(error).slice(0, 200)}`
    report($, `bridge tick failed: ${String(error)}`)
  } finally {
    busy = false
    await writeBridgeStatus($)
  }
}

// ~/.claude/office/bridge.json: when the bridge last ran and how that went, for
// `/office doctor` in any session and `install.sh --check` in a shell.
type BridgeStatus = { at: number; ok: boolean; note: string; sessionId: string; pid: number | null }
let bridgePid: number | null | undefined
async function writeBridgeStatus($: EngineInterface) {
  try {
    if (bridgePid === undefined) bridgePid = await ownPid($)
    const status: BridgeStatus = { at: lastTick.at, ok: lastTick.note.startsWith('第 '), note: lastTick.note, sessionId: await $.session.id(), pid: bridgePid }
    await $.fs.write(`${home}/.claude/office/bridge.json`, JSON.stringify(status))
  } catch (error) {
    report($, `bridge.json could not be written: ${String(error)}`)
  }
}

// What this session can see of the setup: `/office doctor` lists every check,
// `/office` sums them up, and a session that starts with one failing says so.
type Check = { good: boolean; text: string; fix?: string }
async function runChecks($: EngineInterface): Promise<Check[]> {
  const checks: Check[] = []
  const ok = (good: boolean, text: string, fix?: string) => { checks.push({ good, text, fix }) }
  const ago = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)} 秒前` : `${Math.round(ms / 60_000)} 分鐘前`
  const cfgPath = `${home}/.claude/office/config.json`
  ok(true, 'office mod 已載入')
  let parsed = true
  try { JSON.parse(await $.fs.read(cfgPath)) } catch { parsed = false }
  ok(parsed, 'config.json 讀得到、格式正確', `跑 install/install.sh 產生 ${cfgPath}，或檢查 JSON 格式`)
  if (parsed) {
    await loadConfig($)
    ok(/^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/.test(OFFICE_URL), 'officeUrl 已設定', '把發佈好的頁面網址填進 config.json 的 officeUrl')
    if (cfg.jira) {
      const tokenFile = (cfg.jira.tokenFile ?? '~/.jira_api_token').replace(/^~(?=\/|$)/, home)
      ok(await $.fs.exists(tokenFile), `Jira token 檔存在（${tokenFile.replace(home, '~')}）`, 'Jira 不用就把 jira 設成 null；要用就把 API token 存進這個檔，權限 600')
    }
  }
  if (isBridge) {
    ok(true, '這個 session 是橋接')
    ok(toolReady, 'ArtifactData 工具已載入', '橋接要用 --dangerously-skip-permissions 啟動，或在 default 模式允許 ArtifactData')
  } else if (me) {
    const fresh = await $.fs.exists(deskPath(me.id))
    ok(fresh, `這個 session 的桌卡已寫出（${deskPath(me.id).replace(home, '~')}）`, '確認 ~/.claude/office/desks 存在且可寫入')
  }
  let status: BridgeStatus | null = null
  try { status = JSON.parse(await $.fs.read(`${home}/.claude/office/bridge.json`)) as BridgeStatus } catch { /* never ran */ }
  if (!status) ok(false, '橋接還沒跑過', '跑 install/install.sh 裝 LaunchAgent，或開一個分頁：CLAUDE_OFFICE_BRIDGE=1 claude --dangerously-skip-permissions')
  else {
    const age = Date.now() - status.at
    ok(age < 60_000, `橋接最近一輪：${ago(age)}`, '橋接沒在跑：看 ~/.claude/office/bridge-watchdog.log，第一次啟動要在 iTerm 點掉權限與信任資料夾的確認')
    ok(status.ok, `橋接狀態：${status.note}`)
  }
  return checks
}

async function doctor($: EngineInterface): Promise<string> {
  return (await runChecks($)).map(c => `${c.good ? '✅' : '❌'} ${c.text}${!c.good && c.fix ? `\n   → ${c.fix}` : ''}`).join('\n')
}

async function checkSummary($: EngineInterface): Promise<string> {
  const failed = (await runChecks($)).filter(c => !c.good)
  return failed.length ? `設定檢查：❌ ${failed.length} 項有問題（/office doctor 看細節）` : '設定檢查：✅ 全部正常'
}

// Quiet when all is well, so it can run in every session.
async function startupCheck($: EngineInterface) {
  const failed = (await runChecks($)).filter(c => !c.good)
  const first = failed[0]
  if (first) $.ui.toast(`Session Office：${first.text}${failed.length > 1 ? `，另有 ${failed.length - 1} 項` : ''}。打 /office doctor 看細節`, { timeoutMs: 15_000 })
}

// ---- hooks ---------------------------------------------------------------------

export const register: Register = on => {
  // The report format the page relies on rides along with every prompt, so a
  // running session follows it from its next turn (CLAUDE.md is read only at start;
  // prompt.compose is taken by another plugin before ours).
  // the project board rides along with the next prompt whenever it changed since it was last shown
  let boardShown = ''
  on('prompt.submit', async ($, e, next) => {
    const context = [...(e.context ?? []), REPORT_FORMAT()]
    if (me) {
      try {
        const raw = await $.fs.read(boardFile(me.id))
        if (raw !== boardShown) {
          const b = JSON.parse(raw) as { project: string; notes: Note[] }
          if (activeNotes(b.notes).length) context.push(BOARD_CONTEXT(b))
          boardShown = raw
        }
      } catch { /* no board yet */ }
    }
    const mate = teammateOf(e.text)
    if (mate) context.push(sentFor.has(mate.name) ? COMMANDER_CONTEXT(mate.name) : RELAY_CONTEXT(mate.name))
    return next({ ...e, context })
  })
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get('HOME')) ?? ''
    await loadConfig($)
    const sessionId = await $.session.id()
    isBridge = (await $.env.get('CLAUDE_OFFICE_BRIDGE')) === '1' || (await $.store.get('bridgeSessionId')) === sessionId
    if (!e.isInteractive && (await $.env.get('CLAUDE_OFFICE_HEADLESS')) !== '1') return started
    await $.command.register({ name: 'office', description: 'Session Office: link, this desk, `name <text>`, `project <name>`, `doctor`, `bridge`' })

    if (!isBridge) {
      me = {
        id: await $.session.id(),
        label: basename(e.cwd),
        title: ((await $.env.get('CLAUDE_OFFICE_TITLE')) ?? '').trim(),
        cwd: e.cwd,
        branch: await branchOf($, e.cwd),
        state: 'idle',
        task: '',
        activity: '剛上線',
        report: '',
        reportedAt: null,
        startedAt: Date.now(),
        seenAt: Date.now(),
        instructionDoneAt: null,
        pid: await ownPid($),
        tty: await ownTty($),
        blocked: null,
        ask: null,
        projectManual: ((await $.env.get('CLAUDE_OFFICE_PROJECT')) ?? '').trim().slice(0, 60) || null,   // the topic typed in the page's new-session window
      }
      // a reload (or /resume) of a session that already has a desk keeps what the
      // old desk knew: above all which page instruction it last ran, or the one
      // still in its inbox would run a second time
      try {
        const prev = JSON.parse(await $.fs.read(deskPath(me.id))) as Partial<Desk>
        if (prev.id === me.id) {
          me.instructionDoneAt = prev.instructionDoneAt ?? null
          if (typeof prev.startedAt === 'number') me.startedAt = prev.startedAt
          if (!me.title && prev.title) me.title = prev.title
          if (Array.isArray(prev.history)) me.history = prev.history
          if (prev.ctx && prev.ctx.tokens !== null) me.ctx = prev.ctx    // the health bar survives a resume until the next turn measures it
          if (prev.projectManual && !me.projectManual) me.projectManual = prev.projectManual
          // and what the page shows: the task, and a report still waiting for you
          if (prev.task) me.task = prev.task
          if (prev.state === 'reporting' && prev.report) Object.assign(me, { state: 'reporting', activity: prev.activity ?? me.activity, report: prev.report, reportedAt: prev.reportedAt ?? null, blocked: prev.blocked ?? null, ask: prev.ask ?? null })
          else if (prev.report) Object.assign(me, { report: prev.report, reportedAt: prev.reportedAt ?? null })
          // this process is the end of a model switch from the page: the old tab goes
          if (prev.switching) {
            me.switching = null
            me.activity = `已換成 ${prev.switching.to}`
            if (typeof prev.tty === 'string' && prev.tty !== me.tty) void closeTerminal($, prev.tty, null)
          }
        }
      } catch { /* no desk yet */ }
      // a reload must not hand the session back a name it has since been renamed from
      const named = await sessionTitle($)
      if (named) me.title = named
      await noteModel($)
      await setProject($)
      await refreshUsage($)
      await saveDesk($)
      // only a name the engine lost (kept on the desk) goes back through /rename; every save of this file reloads the mod in every session
      if (me.title && !named) await handTitle($, me.title)
      // lets you say "rename yourself to …" in the chat or from the page
      try {
        await $.tool.register({
          name: 'rename',
          description: "Sets this session's nameplate in Session Office. Use only when the user asks to rename this session or its desk. An empty title clears the nameplate.",
          inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'The new name, at most 60 characters.' } }, required: ['title'] },
          isDeferred: false,
        })
      } catch (error) { report($, `rename tool not registered: ${String(error)}`) }
      try {
        await $.tool.register({
          name: 'board',
          description: "Session Office project board: one card per member of this project (each session of the same topic, ticket or repo, and the user). `read` lists the cards (`include_archived` adds the replaced ones); `post` writes your card and replaces your earlier one — do it when you changed something shared, your progress changed, you are waiting on a teammate, or the next session must know something. Technical coordination with a teammate (interfaces, who edits a shared file, naming, ordering) goes to that session by message or on your card, not to the user.",
          inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'post'] }, text: { type: 'string', description: 'post: your card, at most 1000 characters; it replaces your earlier one.' }, include_archived: { type: 'boolean', description: 'read: also list the replaced cards.' } }, required: ['action'] },
          isDeferred: false,
        })
      } catch (error) { report($, `board tool not registered: ${String(error)}`) }
      await $.process.run(['mkdir', '-p', boardPostDir()], { timeoutMs: 5000 }).catch(() => {})
      $.clock.after(15_000, () => { void startupCheck($) })
    }

    let tick = 0
    $.clock.every(TICK_MS, async () => {
      tick += 1
      if (isBridge) return bridgeTick($)
      if (!me) return
      if (tick % HEARTBEAT_EVERY === 0) {
        me.branch = await branchOf($, me.cwd)
        const named = await sessionTitle($)
        if (handingTitle && (named === handingTitle.title || Date.now() - handingTitle.at > 30 * 60_000)) handingTitle = null
        if (named && !handingTitle && named !== me.title) me.title = named
        await refreshUsage($)
        await saveDesk($)
      }
      await checkPermission($)
      await takeInstruction($)
      await checkDelivery($)
    })
    return started
  })

  on('tool.call', { tool: 'mcp__office__rename' }, async ($, e) => {
    if (!me) return { deny: 'This session has no desk in Session Office.' }
    const title = String((e as unknown as { title?: unknown }).title ?? '').trim().slice(0, 60)
    rename($, title)
    return { result: title ? `Nameplate set to "${title}".` : 'Nameplate cleared; it shows the first task again.' }
  })

  on('tool.call', { tool: 'mcp__office__board' }, async ($, e) => {
    if (!me) return { deny: 'This session has no desk in Session Office.' }
    const { action, text, include_archived } = e as unknown as { action?: string; text?: string; include_archived?: boolean }
    let board: { project: string; notes: Note[] } | null = null
    try { board = JSON.parse(await $.fs.read(boardFile(me.id))) } catch { /* not synced yet */ }
    const noProject = 'This desk has no project (the folder is not in git), so there is no board; the user can set a topic with `/office project <name>`.'
    const name = board?.project ?? rootOf(me.project) ?? 'this project'
    if (action === 'post') {
      const note = String(text ?? '').trim().slice(0, 1000)
      if (!note) return { deny: 'Nothing to post.' }
      if (!me.project) return { deny: noProject }
      const at = Date.now()
      await $.fs.write(`${boardPostDir()}/${me.id}-${at}.json`, JSON.stringify({ desk: me.id, by: me.title || me.label, text: note, at }))
      return { result: `Your card on the board of ${name} is updated (the earlier one is archived); the bridge publishes it within a few seconds.` }
    }
    if (!board) return { result: 'No board yet for this desk (the bridge has not synced it, or the desk has no project).' }
    return { result: board.notes.length ? BOARD_CONTEXT(board, !!include_archived) : `The board of ${board.project} is empty.` }
  })

  // /clear typed in the window: wipe the desk the same way (the page's /clear
  // goes through takeInstruction, which this hook does not see).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    if (me) patch($, { ...CLEARED, activity: '對話清空，等新任務' })
    const result = await next(e)
    if (me) { await refreshUsage($); await saveDesk($) }
    return result
  })
  // /rename typed in the window: the nameplate follows the session title
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const result = await next(e)
    handingTitle = null
    const named = e.args.trim() || (/renamed to:\s*(.+)$/m.exec(String((result as { text?: unknown }).text ?? ''))?.[1] ?? '').trim()
    if (me && named && named !== me.title) patch($, { title: named.slice(0, 60) })
    return result
  })
  // /compact refills the health bar: read the new fill once it is done
  // /model typed in the terminal: the page shows the new model now, not at the next turn
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await noteModel($)
    return result
  })

  on('command.run', { command: 'compact' }, async ($, e, next) => {
    const result = await next(e)
    if (me) { await refreshUsage($); await saveDesk($) }
    return result
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    if (sub === 'name' && me) {
      const title = rest.join(' ').trim()
      rename($, title)
      return { text: title ? `桌牌改成「${title}」。` : '桌牌清掉了，改回顯示第一句任務。' }
    }
    if (sub === 'project' && me) {
      me.projectManual = rest.join(' ').trim().slice(0, 60)
      await setProject($)
      return { text: me.projectManual ? `專案改成「${me.project}」。` : `專案改回自動判斷。${projectText()}` }
    }
    if (sub === 'doctor') return { text: await doctor($) }
    if (sub === 'status') {
      return {
        text: [
          `角色：${isBridge ? '橋接' : '工作視窗'}`,
          `最近一輪：${lastTick.at ? Math.round((Date.now() - lastTick.at) / 1000) + ' 秒前' : '無'} · ${lastTick.note}`,
          `工具：${toolReady ? 'ArtifactData 已載入' : 'ArtifactData 未載入'}`,
          ...(isBridge ? [`Jira：${jiraNote}`] : []),
        ].join('\n'),
      }
    }
    if (sub === 'bridge' && rest[0] === 'off') {
      isBridge = false
      await $.store.delete('bridgeSessionId')
      return { text: '這個 session 不再是橋接。' }
    }
    if (sub === 'bridge') {
      await $.store.set('bridgeSessionId', await $.session.id())
      if (me) {
        patch($, { state: 'gone' })
        await saveDesk($)
        me = null
      }
      isBridge = true
      return { text: '這個 session 現在是辦公室的橋接：每 5 秒把 ~/.claude/office/ 的桌卡同步進頁面，並把頁面上的指令送回各 session。要在 default 或 acceptEdits 模式下才寫得進去。' }
    }
    return {
      text: [
        `Session Office：${OFFICE_URL || '（~/.claude/office/config.json 還沒設定 officeUrl）'}`,
        isBridge ? '角色：橋接（不佔桌子）' : `這個 session 的桌卡：${me ? `${me.title || me.label} · ${me.branch ?? '(no branch)'} · ${me.state}` : '尚未建立'}`,
        await checkSummary($),
        '指令：/office name <桌牌>、/office doctor、/office bridge、/office bridge off、/office status',
      ].join('\n'),
    }
  })

  on('classic.PreModelSwitch', async ($, e, next) => {
    if (e.source === 'command' && Date.now() - pageModelSwitchAt < 30_000) {
      pageModelSwitchAt = 0
      return { permissionDecision: 'allow', permissionDecisionReason: 'office: the model picked on the page' }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const mate = e.agentId === undefined ? teammateOf(e.text) : null
    if (e.agentId === undefined) { runningTurn = e.turnId; turnFrom = mate?.name ?? null }
    if (e.agentId === undefined && me) {
      const p: Partial<Desk> = { state: 'working', activity: '思考中', bg: null, relay: null }
      if (pendingInstruction && e.text.includes(pendingInstruction.text.slice(0, 200))) {
        p.delivery = { at: pendingInstruction.at, state: 'delivered' }
        pendingInstruction = null
      } else if (me.delivery?.state === 'failed') p.delivery = null    // typed in the terminal instead: the lost mark has served its purpose
      const task = mate ? `${mate.name}：${firstLine(mate.body, 70)}` : isMetaPrompt(e.text) ? '' : firstLine(e.text, 80)
      if (task) p.task = task
      // a session renamed some way the desk missed keeps that name, not this prompt
      if (task && !me.title) p.title = (await sessionTitle($)) || firstLine(e.text, 24)
      patch($, p)
      // an unnamed session takes its nameplate as its title, so the name on the page is the name to message it by
      if (p.title) void handTitle($, p.title)
    }
    return next(e)
  })

  // the model and effort each main-loop request goes out with, for the page's info line
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && me) {
      const effort = e.effort === undefined ? null : String(e.effort)
      if (e.model !== me.model || effort !== (me.effort ?? null)) patch($, { model: e.model, effort })
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || !me) return next(e)
    // work sent out on the person's behalf (or passed on while gathering it): the reply comes back here to be reported
    if (e.tool === 'SendMessage' && (turnFrom === null || sentFor.has(turnFrom))) {
      const to = String((e as unknown as { to?: unknown }).to ?? '').replace(/\s*\[[^\]]*\]\s*$/, '').trim()
      if (to) sentFor.add(to)
    }
    if (e.tool === 'AskUserQuestion') {
      // The model asks the person to choose. The dog brings the question to the
      // office; it can be answered there or in the terminal, whichever is first.
      const raw = (e as unknown as { questions?: AskQuestion[] }).questions ?? []
      const ask: AskQuestion[] = raw.map(q => ({ question: q.question, header: q.header, multiSelect: !!q.multiSelect, options: (q.options ?? []).map(o => ({ label: o.label, description: o.description })) }))
      const md = ask.map(q => `**${q.header}**　${q.question}\n` + q.options.map(o => `- **${o.label}**${o.description ? '：' + o.description : ''}`).join('\n')).join('\n\n')
      patch($, { state: 'reporting', activity: '等你選擇', blocked: 'question', ask, report: `### 需要你決定\n\n${md}`, reportedAt: Date.now() })
      let settled = false
      const fromPage = waitForAnswer($, ask, next.signal, () => settled)
      const fromTerminal = next(e)
      const first = await Promise.race([fromTerminal.then(r => ({ r })), fromPage.then(a => ({ a }))])
      settled = true
      patch($, { state: 'working', activity: '收到你的回答', blocked: null, ask: null })
      if ('r' in first) return first.r
      if (!first.a) return fromTerminal                        // the wait ended without an answer
      return { result: { questions: raw, answers: first.a } } as never
    }
    patch($, { state: 'working', activity: describe(e as { tool: string } & Record<string, unknown>) }, { throttle: true })
    const result = await next(e)
    permSettledAt = Date.now()
    // the dialog was answered (here or from the page): the settings hook stops waiting for the page
    try { const sid = await $.session.id(); if (await $.fs.exists(`${hookDir()}/perm-${sid}.json`)) await $.fs.write(`${hookDir()}/settled-${sid}`, String(permSettledAt)) } catch { /* no hook dir */ }
    if (me?.blocked === 'permission') patch($, { state: 'working', activity: '權限已處理，繼續', blocked: null, perm: null })
    return result
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) runningTurn = null
    if (e.agentId === undefined && me) {
      await refreshUsage($, true)
      if (e.reason === 'aborted') patch($, { state: 'idle', activity: pausing ? '已暫停' : '被中斷', blocked: null, ask: null, bg: null })
      else {
        const report = (e.answer ?? '').trim().slice(0, 4000) || (e.reason === 'error' ? errorReport(await lastApiError($)) : `_（這輪沒有文字回覆：${e.reason === 'refusal' ? '模型拒絕' : e.reason}）_`)
        const at = Date.now()
        const history = [...(me.history ?? []), { at, task: me.task, report }].slice(-HISTORY_KEEP)
        // a teammate's errand is answered to that teammate; only a decision the person must make calls them over
        const relay = e.reason === 'answer' && turnFrom !== null && !sentFor.has(turnFrom) && !DECIDE_RE.test(e.answer ?? '') ? turnFrom : null
        if (relay) patch($, { state: 'idle', activity: `已回覆 ${relay}`, relay, blocked: null, ask: null, report, reportedAt: at, history, bg: null })
        else patch($, { state: 'reporting', activity: '等你回覆', blocked: null, ask: null, report, reportedAt: at, history, bg: null })
        // the Stop settings hook writes what is still running a moment later
        $.clock.after(1500, () => { void checkBackground($, at) })
      }
      pausing = false
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') sentFor.clear()
    if (me && (e.reason === 'clear' || e.reason === 'resume')) {
      // The conversation ends but the process goes on under a new id, with no
      // session.start: keep the desk, wipe the conversation's task and report.
      patch($, { state: 'idle', activity: e.reason === 'clear' ? '對話清空，等新任務' : '接回別的對話', task: '', title: '', report: '', reportedAt: null })
      await saveDesk($)
    } else if (me && switching) {
      // the desk stays: the resumed process takes it over under the same id
      await saveDesk($)
      me = null
    } else if (me) {
      patch($, { state: 'gone', activity: '已下線' })
      await saveDesk($)
      me = null
    }
    return next(e)
  })
}
