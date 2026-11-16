import type { Register, EngineInterface } from 'claude-code'

// Session Office: every session keeps a desk card as a local file; one bridge
// session (CLAUDE_OFFICE_BRIDGE=1, or `/office bridge`) copies the files into
// the artifact's database and brings instructions typed on the page back as
// files. Workers never call a tool, so they run under auto mode untouched.
// Everything about the person running it lives in ~/.claude/office/config.json:
// { officeUrl, jira?: { site, email, jql?, tokenFile? }, codex?, city?: { lat, lng }, newSessionDirs?, language? }
type OfficeConfig = {
  officeUrl?: string
  jira?: { site: string; email: string; jql?: string; tokenFile?: string } | null
  codex?: boolean
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
  blocked: 'permission' | 'question' | null
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
const inboxPath = (id: string) => `${inboxDir()}/${id}.json`

// What a /clear leaves on the desk: the conversation's task, title and report go.
const CLEARED: Partial<Desk> = { state: 'idle', task: '', title: '', report: '', reportedAt: null, blocked: null, ask: null }
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
async function refreshUsage($: EngineInterface) {
  if (!me) return
  try {
    const u = await $.session.usage()
    const tokens = typeof u.context.tokens === 'number' ? u.context.tokens : null
    const percent = typeof u.context.percent === 'number' ? u.context.percent
      : tokens !== null && u.context.window > 0 ? Math.round(tokens / u.context.window * 100) : null
    me.ctx = { tokens, window: u.context.window, percent }
    me.cost = u.cost ? Math.round(u.cost.usd * 100) / 100 : null
    if (u.rateLimits.length) {
      me.limits = u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, ...(r.resetsAt ? { resetsAt: r.resetsAt } : {}) }))
      me.limitsAt = Date.now()
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
  if (!me || me.blocked === 'question') return
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
      if (name === 'clear') patch($, { ...CLEARED, activity: '執行 /clear' })
      else patch($, { activity: `執行 /${name}` })
      await $.command.run({ command: name, args: rest.join(' ') })
      return
    }
    patch($, { state: 'working', activity: '收到辦公室的指令', task: firstLine(instruction, 80) })
    await $.prompt.submit({ text: instruction, asUser: true })
  } catch (error) {
    report($, `instruction from the office could not be run: ${String(error)}`)
  }
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
const requested = new Set<string>()
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
    const mark = async (status: string, extra: Record<string, unknown> = {}) => {
      await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OFFICE_URL, collection: REQUESTS, doc_id: id, data: { status, ...extra }, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
    }
    let isDir = false
    try { isDir = (await $.fs.stat(cwd)).kind === 'dir' } catch { isDir = false }
    if (!cwd || !isDir) { await mark('failed', { error: `目錄不存在：${cwd || '(空)'}` }); continue }
    const command = `cd ${shellQuote(cwd)} && CLAUDE_OFFICE_TITLE=${shellQuote(title)} claude${task ? ' ' + shellQuote(task) : ''}`
    const script = [
      'tell application "iTerm2"',
      '  activate',
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
  const pub = JSON.stringify({ jiraSite: cfg.jira?.site ?? null, codex: cfg.codex !== false, city: cfg.city ?? null, newSessionDirs: (cfg.newSessionDirs ?? []).map(d => d.replace(/^~(?=\/|$)/, home)) })
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
    const ok = await putMeta($, 'jira', { fetchedAt: Date.now(), site: cfg.jira.site, jql: cfg.jira.jql ?? JIRA_JQL, issues })
    jiraNote = ok ? `${issues.length} 張票，${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 更新` : '寫入 meta/jira 失敗'
  } catch (error) {
    jiraNote = `失敗：${String(error).slice(0, 200)}`
    report($, `Jira: ${jiraNote}`)
  }
}

// The heading follows `language` in config.json ("zh-TW" by default, or "en"); the page reads both.
const DECIDE_HEADING = () => (cfg.language === 'en' ? 'Decisions for you' : '要你決定')
const REPORT_FORMAT = () => `# Report format (Session Office)\nWhen a reply has anything the user must decide or answer, collect all of it in a final section headed exactly \`## ${DECIDE_HEADING()}\`: one line per item with the question, the options and your recommendation, at most 3 items. Do not leave such questions in the conclusion or the details, and put nothing after this section. Leave the heading out when there is nothing to decide. The Session Office page finds this heading to show the decisions as their own highlighted block.`

// Codex: every Codex call logs the account's limits in its rollout file
// (~/.codex/sessions/**/rollout-*.jsonl, a token_count event). The bridge
// publishes the latest one as meta/codex for the Codex coworker on the page.
const CODEX_EVERY = 12                      // every 12th tick: 1 minute
const CODEX_LATEST = `for f in $(ls -t $(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -8 2>/dev/null) 2>/dev/null | head -5); do l=$(grep '"rate_limits"' "$f" | tail -1); [ -n "$l" ] && { printf '%s' "$l"; exit 0; }; done`
let codexLast = ''

async function syncCodex($: EngineInterface) {
  if (cfg.codex === false) return
  try {
    const ran = await $.process.run(['sh', '-c', CODEX_LATEST], { timeoutMs: 10_000 })
    if (!ran.stdout.trim()) return
    const line = JSON.parse(ran.stdout) as { timestamp?: string; payload?: { rate_limits?: Record<string, any> } }
    const rl = line.payload?.rate_limits
    if (!rl) return
    const win = (w: any) => w && typeof w.used_percent === 'number' ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes ?? null, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null } : null
    const data = { primary: win(rl.primary), secondary: win(rl.secondary), at: Date.parse(line.timestamp ?? '') || null }
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

const FOCUS_TAB_SCRIPT = `on run argv
  set wanted to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is wanted then
            tell t to select
            tell w to select
            activate
            return "focused"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not found"
end run`

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
    if (tickCount === 3 || tickCount % CODEX_EVERY === 0) await syncCodex($)
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
    for (const [id, desk] of files) if (typeof desk.pid === 'number' && desk.state !== 'gone' && !(await processAlive($, desk.pid))) dead.add(id)
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
        await $.process.run(['rm', '-f', deskPath(id), inboxPath(id)])
        delete synced[id]
        delete inboxWritten[id]
        continue
      }
      const data: Record<string, unknown> = { ...desk, seat: seatOf[id] }
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

    await openRequestedSessions($)

    for (const [id, doc] of docs) {
      if (!files.has(id)) {
        await $.tool.call({ tool: 'ArtifactData', action: 'delete', url: OFFICE_URL, collection: COLLECTION, doc_id: id, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
        continue
      }
      const instruction = typeof doc.data.instruction === 'string' ? doc.data.instruction : ''
      const at = typeof doc.data.instructionAt === 'number' ? doc.data.instructionAt : 0
      const done = typeof doc.data.instructionDoneAt === 'number' ? doc.data.instructionDoneAt : 0
      if (instruction === '/focus' && at > done && inboxWritten[id] !== at) {
        // handled here, not by the session: bring its terminal tab to the front
        inboxWritten[id] = at
        const tty = files.get(id)?.tty
        if (typeof tty === 'string') await $.process.run(['osascript', '-e', FOCUS_TAB_SCRIPT, tty], { timeoutMs: 15_000 }).catch(error => report($, `focus ${tty}: ${String(error)}`))
        await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OFFICE_URL, collection: COLLECTION, doc_id: id, data: { instructionDoneAt: at }, ...(doc.version !== undefined ? { if_version: doc.version } : {}) })
        continue
      }
      if (instruction && at > done && inboxWritten[id] !== at) {
        const images = Array.isArray(doc.data.images) ? doc.data.images.filter((x): x is string => typeof x === 'string') : []
        const paths = images.length ? await saveImages($, images) : []
        const text = paths.length ? `${instruction}\n\n（附圖已存在本機，請用 Read 讀取）\n${paths.map(p => `- ${p}`).join('\n')}` : instruction
        await $.fs.write(inboxPath(id), JSON.stringify({ instruction: text, instructionAt: at }))
        inboxWritten[id] = at
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
  on('prompt.submit', async ($, e, next) => next({ ...e, context: [...(e.context ?? []), REPORT_FORMAT()] }))
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get('HOME')) ?? ''
    await loadConfig($)
    const sessionId = await $.session.id()
    isBridge = (await $.env.get('CLAUDE_OFFICE_BRIDGE')) === '1' || (await $.store.get('bridgeSessionId')) === sessionId
    if (!e.isInteractive && (await $.env.get('CLAUDE_OFFICE_HEADLESS')) !== '1') return started
    await $.command.register({ name: 'office', description: 'Session Office: link, this desk, `name <text>`, `doctor`, `bridge`' })

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
          // and what the page shows: the task, and a report still waiting for you
          if (prev.task) me.task = prev.task
          if (prev.state === 'reporting' && prev.report) Object.assign(me, { state: 'reporting', activity: prev.activity ?? me.activity, report: prev.report, reportedAt: prev.reportedAt ?? null, blocked: prev.blocked ?? null, ask: prev.ask ?? null })
          else if (prev.report) Object.assign(me, { report: prev.report, reportedAt: prev.reportedAt ?? null })
        }
      } catch { /* no desk yet */ }
      await refreshUsage($)
      await saveDesk($)
      $.clock.after(15_000, () => { void startupCheck($) })
    }

    let tick = 0
    $.clock.every(TICK_MS, async () => {
      tick += 1
      if (isBridge) return bridgeTick($)
      if (!me) return
      if (tick % HEARTBEAT_EVERY === 0) {
        me.branch = await branchOf($, me.cwd)
        await refreshUsage($)
        await saveDesk($)
      }
      await takeInstruction($)
    })
    return started
  })

  // /clear typed in the window: wipe the desk the same way (the page's /clear
  // goes through takeInstruction, which this hook does not see).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    if (me) patch($, { ...CLEARED, activity: '對話清空，等新任務' })
    const result = await next(e)
    if (me) { await refreshUsage($); await saveDesk($) }
    return result
  })
  // /compact refills the health bar: read the new fill once it is done
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    const result = await next(e)
    if (me) { await refreshUsage($); await saveDesk($) }
    return result
  })

  on('command.run', { command: 'office' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    if (sub === 'name' && me) {
      const title = rest.join(' ').trim()
      patch($, { title })
      return { text: title ? `桌牌改成「${title}」。` : '桌牌清掉了，改回顯示第一句任務。' }
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

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && me) {
      const p: Partial<Desk> = { state: 'working', activity: '思考中' }
      const task = isMetaPrompt(e.text) ? '' : firstLine(e.text, 80)
      if (task) p.task = task
      if (task && !me.title) p.title = firstLine(e.text, 24)
      patch($, p)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || !me) return next(e)
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
    if (me?.blocked === 'permission') patch($, { state: 'working', activity: '權限已處理，繼續', blocked: null })
    return result
  })
  // The terminal is about to show a permission dialog: the session stops until
  // someone answers it there, so it walks to the office and says so. The
  // tool.call hook above clears it once the call settles either way.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (me && !(e as { agent_id?: string }).agent_id) {
      const what = describe({ tool: e.tool_name, ...((e.tool_input ?? {}) as Record<string, unknown>) })
      const input = (e.tool_input ?? {}) as { command?: unknown }
      const detail = typeof input.command === 'string' ? '\n\n```\n' + input.command.slice(0, 600) + '\n```' : ''
      patch($, { state: 'reporting', activity: '等你確認權限', blocked: 'permission', reportedAt: Date.now(), report: `### 在 terminal 等你確認權限\n\n${what}${detail}\n\n_切到它的 terminal 分頁按允許或拒絕。_` })
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && me) {
      await refreshUsage($)
      if (e.reason === 'aborted') patch($, { state: 'idle', activity: '被中斷', blocked: null, ask: null })
      else {
        const report = (e.answer ?? '').trim().slice(0, 4000) || `_（這輪沒有文字回覆：${e.reason === 'error' ? 'API 錯誤' : e.reason === 'refusal' ? '模型拒絕' : e.reason}）_`
        const at = Date.now()
        const history = [...(me.history ?? []), { at, task: me.task, report }].slice(-HISTORY_KEEP)
        patch($, { state: 'reporting', activity: '等你回覆', blocked: null, ask: null, report, reportedAt: at, history })
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (me && (e.reason === 'clear' || e.reason === 'resume')) {
      // The conversation ends but the process goes on under a new id, with no
      // session.start: keep the desk, wipe the conversation's task and report.
      patch($, { state: 'idle', activity: e.reason === 'clear' ? '對話清空，等新任務' : '接回別的對話', task: '', title: '', report: '', reportedAt: null })
      await saveDesk($)
    } else if (me) {
      patch($, { state: 'gone', activity: '已下線' })
      await saveDesk($)
      me = null
    }
    return next(e)
  })
}
