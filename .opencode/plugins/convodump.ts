import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

const SERVICE_NAME = "opencode-convodump"
const SCHEMA_VERSION = 1
const DEBOUNCE_MS = 175

type UnknownRecord = Record<string, unknown>

type SessionState = {
  timer?: ReturnType<typeof setTimeout>
  queue: Promise<void>
  pendingTrigger?: string
  lastWriteAt?: number
  lastFingerprint?: string
}

type SessionSnapshot = {
  session: UnknownRecord
  messages: unknown[]
  todos: unknown
  diff: unknown
}

function normaliseNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n")
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

function asObject(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as UnknownRecord
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value

  if (typeof value === "number" && Number.isFinite(value)) {
    const asMillis = value < 1_000_000_000_000 ? value * 1000 : value
    const parsed = new Date(asMillis)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  return null
}

function toISO(value: unknown): string | null {
  const parsed = parseDate(value)
  return parsed ? parsed.toISOString() : null
}

function formatFilenameTimestamp(value: unknown): string {
  const parsed = parseDate(value) ?? new Date()
  const year = parsed.getFullYear().toString().padStart(4, "0")
  const month = (parsed.getMonth() + 1).toString().padStart(2, "0")
  const day = parsed.getDate().toString().padStart(2, "0")
  const hour = parsed.getHours().toString().padStart(2, "0")
  const minute = parsed.getMinutes().toString().padStart(2, "0")
  const second = parsed.getSeconds().toString().padStart(2, "0")
  return `${year}-${month}-${day}-${hour}-${minute}-${second}`
}

function sanitiseFilename(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_")
  return safe || "unknown-session"
}

function quoteYamlString(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  return `"${escaped}"`
}

function writeYamlPair(lines: string[], key: string, value: unknown, indent: number): void {
  const pad = " ".repeat(indent)

  if (value === null || value === undefined) {
    lines.push(`${pad}${key}: null`)
    return
  }

  if (typeof value === "string") {
    if (value.includes("\n")) {
      lines.push(`${pad}${key}: |-`)
      for (const segment of value.split("\n")) {
        lines.push(`${pad}  ${segment}`)
      }
    } else {
      lines.push(`${pad}${key}: ${quoteYamlString(value)}`)
    }
    return
  }

  if (typeof value === "number" || typeof value === "boolean") {
    lines.push(`${pad}${key}: ${String(value)}`)
    return
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}${key}: []`)
      return
    }

    lines.push(`${pad}${key}:`)
    for (const item of value) {
      writeYamlArrayItem(lines, item, indent + 2)
    }
    return
  }

  const objectValue = asObject(value)
  const entries = Object.entries(objectValue)
  if (entries.length === 0) {
    lines.push(`${pad}${key}: {}`)
    return
  }

  lines.push(`${pad}${key}:`)
  for (const [childKey, childValue] of entries) {
    writeYamlPair(lines, childKey, childValue, indent + 2)
  }
}

function writeYamlArrayItem(lines: string[], value: unknown, indent: number): void {
  const pad = " ".repeat(indent)

  if (value === null || value === undefined) {
    lines.push(`${pad}- null`)
    return
  }

  if (typeof value === "string") {
    if (value.includes("\n")) {
      lines.push(`${pad}- |-`)
      for (const segment of value.split("\n")) {
        lines.push(`${pad}  ${segment}`)
      }
    } else {
      lines.push(`${pad}- ${quoteYamlString(value)}`)
    }
    return
  }

  if (typeof value === "number" || typeof value === "boolean") {
    lines.push(`${pad}- ${String(value)}`)
    return
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}- []`)
      return
    }

    lines.push(`${pad}-`)
    for (const item of value) {
      writeYamlArrayItem(lines, item, indent + 2)
    }
    return
  }

  const objectValue = asObject(value)
  const entries = Object.entries(objectValue)
  if (entries.length === 0) {
    lines.push(`${pad}- {}`)
    return
  }

  let first = true
  for (const [key, child] of entries) {
    if (first) {
      if (
        child === null ||
        child === undefined ||
        typeof child === "string" ||
        typeof child === "number" ||
        typeof child === "boolean"
      ) {
        if (typeof child === "string" && child.includes("\n")) {
          lines.push(`${pad}- ${key}: |-`)
          for (const segment of child.split("\n")) {
            lines.push(`${pad}    ${segment}`)
          }
        } else if (child === null || child === undefined) {
          lines.push(`${pad}- ${key}: null`)
        } else if (typeof child === "string") {
          lines.push(`${pad}- ${key}: ${quoteYamlString(child)}`)
        } else {
          lines.push(`${pad}- ${key}: ${String(child)}`)
        }
      } else {
        lines.push(`${pad}- ${key}:`)
        if (Array.isArray(child)) {
          if (child.length === 0) {
            lines.push(`${pad}    []`)
          } else {
            for (const nested of child) {
              writeYamlArrayItem(lines, nested, indent + 4)
            }
          }
        } else {
          const nestedEntries = Object.entries(asObject(child))
          if (nestedEntries.length === 0) {
            lines.push(`${pad}    {}`)
          } else {
            for (const [nestedKey, nestedValue] of nestedEntries) {
              writeYamlPair(lines, nestedKey, nestedValue, indent + 4)
            }
          }
        }
      }
      first = false
      continue
    }

    writeYamlPair(lines, key, child, indent + 2)
  }
}

function toYaml(value: UnknownRecord): string {
  const lines: string[] = []
  for (const [key, child] of Object.entries(value)) {
    writeYamlPair(lines, key, child, 0)
  }
  return lines.join("\n")
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson)
  if (!value || typeof value !== "object") return value

  const sorted: UnknownRecord = {}
  const entries = Object.entries(value as UnknownRecord).sort(([a], [b]) => a.localeCompare(b))
  for (const [key, child] of entries) {
    sorted[key] = sortForStableJson(child)
  }
  return sorted
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value), null, 2)
}

function snapshotFingerprint(snapshot: SessionSnapshot): string {
  const session = snapshot.session
  const time = asObject(session.time)

  const minimal = {
    session_id: session.id ?? null,
    session_updated_at: time.updated ?? session.updatedAt ?? session.updated_at ?? null,
    message_count: snapshot.messages.length,
    message_ids: snapshot.messages.map((message) => {
      const msg = asObject(message)
      const info = asObject(msg.info)
      return msg.id ?? info.id ?? null
    }),
    part_counts: snapshot.messages.map((message) => asArray(asObject(message).parts).length),
    todos: snapshot.todos,
    diff: snapshot.diff,
  }

  return stableJson(minimal)
}

function codeFence(content: string): string {
  let longest = 2
  for (const match of content.matchAll(/`+/g)) {
    const runLength = match[0]?.length ?? 0
    if (runLength > longest) longest = runLength
  }
  return "`".repeat(longest + 1)
}

function renderCodeBlock(content: string, language = ""): string {
  const clean = normaliseNewlines(content)
  const fence = codeFence(clean)
  const suffix = language ? language : ""
  return `${fence}${suffix}\n${clean}\n${fence}`
}

function renderAnyBlock(value: unknown, language = "json"): string {
  if (typeof value === "string") return renderCodeBlock(value, language)
  return renderCodeBlock(stableJson(value), language)
}

function resolveSessionIdFromEvent(event: UnknownRecord): string | null {
  const props = asObject(event.properties)
  const session = asObject(props.session)

  const candidate =
    props.sessionID ??
    props.sessionId ??
    props.id ??
    props.session_id ??
    session.id ??
    session.sessionID ??
    session.sessionId

  if (typeof candidate !== "string" || candidate.trim() === "") return null
  return candidate
}

function getMessageRole(message: unknown): string {
  const msg = asObject(message)
  const info = asObject(msg.info)
  const role = msg.role ?? info.role ?? info.type
  return asString(role, "unknown")
}

function buildStats(messages: unknown[]): UnknownRecord {
  const partTypeCounts: Record<string, number> = {}
  let partCount = 0
  let userCount = 0
  let assistantCount = 0

  for (const message of messages) {
    const role = getMessageRole(message)
    if (role === "user") userCount += 1
    if (role === "assistant") assistantCount += 1

    const parts = asArray(asObject(message).parts)
    partCount += parts.length

    for (const part of parts) {
      const type = asString(asObject(part).type, "unknown")
      partTypeCounts[type] = (partTypeCounts[type] ?? 0) + 1
    }
  }

  return {
    message_count: messages.length,
    user_count: userCount,
    assistant_count: assistantCount,
    part_count: partCount,
    part_type_counts: partTypeCounts,
  }
}

function buildFrontmatterSession(session: UnknownRecord, ctx: UnknownRecord): UnknownRecord {
  const time = asObject(session.time)
  const share = asObject(session.share)

  const known: UnknownRecord = {
    id: session.id ?? null,
    title: session.title ?? null,
    project_id: session.projectID ?? session.projectId ?? null,
    directory: session.directory ?? ctx.directory ?? null,
    worktree: session.worktree ?? ctx.worktree ?? null,
    parent_id: session.parentID ?? session.parentId ?? null,
    version: session.version ?? null,
    created_at: toISO(time.created ?? session.createdAt ?? session.created_at),
    updated_at: toISO(time.updated ?? session.updatedAt ?? session.updated_at),
    share_url: share.url ?? session.shareURL ?? session.share_url ?? null,
    permissions: session.permissions ?? null,
  }

  const consumedKeys = new Set([
    "id",
    "title",
    "projectID",
    "projectId",
    "directory",
    "worktree",
    "parentID",
    "parentId",
    "version",
    "time",
    "createdAt",
    "created_at",
    "updatedAt",
    "updated_at",
    "share",
    "shareURL",
    "share_url",
    "permissions",
  ])

  const extras: UnknownRecord = {}
  for (const [key, value] of Object.entries(session)) {
    if (consumedKeys.has(key)) continue
    extras[key] = value
  }

  if (Object.keys(extras).length > 0) {
    known.additional = extras
  }

  known.raw_json = stableJson(session)
  return known
}

function formatSessionLabel(session: UnknownRecord): string {
  const title = asString(session.title, "").trim()
  if (title !== "") return title
  return asString(session.id, "Untitled Session")
}

function renderPart(part: UnknownRecord, index: number): string {
  const type = asString(part.type, "unknown")
  const section: string[] = []

  section.push(`#### Part ${index + 1}: ${type}`)
  section.push("")
  section.push(`- id: \`${asString(part.id, "n/a")}\``)
  section.push(`- type: \`${type}\``)
  section.push(`- sessionID: \`${asString(part.sessionID ?? part.sessionId, "n/a")}\``)
  section.push(`- messageID: \`${asString(part.messageID ?? part.messageId, "n/a")}\``)

  if (type === "text") {
    section.push(`- synthetic: ${String(Boolean(part.synthetic))}`)
    section.push(`- ignored: ${String(Boolean(part.ignored))}`)
    section.push("")
    section.push("Text:")
    section.push(renderAnyBlock(part.text ?? part.content ?? "", "text"))
  } else if (type === "reasoning") {
    section.push("")
    section.push("Thinking:")
    section.push(renderAnyBlock(part.text ?? part.reasoning ?? part.content ?? "", "text"))
  } else if (type === "tool") {
    section.push(`- tool: \`${asString(part.tool ?? part.name ?? part.toolName, "unknown")}\``)
    section.push(`- callID: \`${asString(part.callID ?? part.callId, "n/a")}\``)
    section.push(`- status: \`${asString(part.status, "unknown")}\``)
    if (part.title !== undefined) section.push(`- title: ${asString(part.title, "")}`)
    section.push("")
    section.push("Tool input:")
    section.push(renderAnyBlock(part.input ?? part.arguments ?? part.args ?? null))
    section.push("")
    section.push("Tool output:")
    section.push(renderAnyBlock(part.output ?? part.result ?? null))
    if (part.error !== undefined) {
      section.push("")
      section.push("Tool error:")
      section.push(renderAnyBlock(part.error))
    }
    if (part.attachments !== undefined) {
      section.push("")
      section.push("Tool attachments:")
      section.push(renderAnyBlock(part.attachments))
    }
  } else if (type === "file") {
    section.push(`- filename: \`${asString(part.filename ?? part.name, "unknown")}\``)
    section.push(`- mime: \`${asString(part.mime ?? part.mimeType, "unknown")}\``)
    section.push(`- url: ${asString(part.url, "n/a")}`)
    if (part.source !== undefined) {
      section.push("- source:")
      section.push(renderAnyBlock(part.source))
    }
  } else if (type === "subtask") {
    section.push(`- agent: \`${asString(part.agent, "unknown")}\``)
    section.push(`- model: \`${asString(part.model, "unknown")}\``)
    section.push(`- command: \`${asString(part.command, "")}\``)
    if (part.description !== undefined) {
      section.push("")
      section.push("Description:")
      section.push(renderAnyBlock(part.description, "text"))
    }
    if (part.prompt !== undefined) {
      section.push("")
      section.push("Prompt:")
      section.push(renderAnyBlock(part.prompt, "text"))
    }
  } else if (type === "step-start" || type === "step-finish") {
    if (part.reason !== undefined) section.push(`- reason: ${asString(part.reason, "")}`)
    if (part.cost !== undefined) section.push(`- cost: ${asString(part.cost, "")}`)
    if (part.tokens !== undefined) section.push(`- tokens: ${asString(part.tokens, "")}`)
    if (part.snapshot !== undefined) {
      section.push("")
      section.push("Snapshot:")
      section.push(renderAnyBlock(part.snapshot))
    }
  } else if (
    type === "snapshot" ||
    type === "patch" ||
    type === "agent" ||
    type === "retry" ||
    type === "compaction"
  ) {
    section.push("")
    section.push("Type payload:")
    section.push(renderAnyBlock(part))
  } else {
    section.push("")
    section.push("Unknown part type payload:")
    section.push(renderAnyBlock(part))
  }

  section.push("")
  section.push("Raw part JSON:")
  section.push(renderAnyBlock(part))

  return section.join("\n")
}

function renderMessage(message: unknown, index: number): string {
  const msg = asObject(message)
  const info = asObject(msg.info)
  const parts = asArray(msg.parts)
  const role = getMessageRole(msg)

  const section: string[] = []
  section.push(`### Message ${index + 1}: ${role}`)
  section.push("")
  section.push(`- id: \`${asString(msg.id ?? info.id, "n/a")}\``)
  section.push(`- role: \`${role}\``)

  if (msg.time !== undefined) {
    section.push(`- time: ${asString(msg.time, "n/a")}`)
  } else if (info.time !== undefined) {
    section.push(`- time: ${asString(info.time, "n/a")}`)
  }

  section.push("")
  section.push("Message info JSON:")
  section.push(renderAnyBlock(info))

  if (parts.length === 0) {
    section.push("")
    section.push("No parts in this message.")
    return section.join("\n")
  }

  section.push("")
  section.push(`Parts (${parts.length}):`)
  for (let i = 0; i < parts.length; i += 1) {
    section.push("")
    section.push(renderPart(asObject(parts[i]), i))
  }

  return section.join("\n")
}

function renderMarkdown(snapshot: SessionSnapshot, trigger: string, ctx: UnknownRecord): string {
  const session = snapshot.session
  const messages = snapshot.messages
  const todos = snapshot.todos
  const diff = snapshot.diff

  const frontmatter: UnknownRecord = {
    schema_version: SCHEMA_VERSION,
    exporter: {
      name: SERVICE_NAME,
      generated_at: new Date().toISOString(),
      trigger,
    },
    session: buildFrontmatterSession(session, ctx),
    stats: buildStats(messages),
  }

  const content: string[] = []
  content.push("---")
  content.push(toYaml(frontmatter))
  content.push("---")
  content.push("")
  content.push(`# ${formatSessionLabel(session)}`)
  content.push("")
  content.push("## Session")
  content.push("")
  content.push(`- id: \`${asString(session.id, "n/a")}\``)
  content.push(`- title: ${asString(session.title, "(none)")}`)
  content.push(`- project_id: \`${asString(session.projectID ?? session.projectId, "n/a")}\``)
  content.push(`- directory: \`${asString(session.directory ?? ctx.directory, "n/a")}\``)
  content.push(`- worktree: \`${asString(session.worktree ?? ctx.worktree, "n/a")}\``)
  content.push(`- parent_id: \`${asString(session.parentID ?? session.parentId, "n/a")}\``)
  content.push(`- version: \`${asString(session.version, "n/a")}\``)
  content.push(`- created_at: ${asString(toISO(asObject(session.time).created ?? session.createdAt), "n/a")}`)
  content.push(`- updated_at: ${asString(toISO(asObject(session.time).updated ?? session.updatedAt), "n/a")}`)
  content.push(`- share_url: ${asString(asObject(session.share).url ?? session.shareURL, "n/a")}`)

  if (todos !== null && todos !== undefined) {
    content.push("")
    content.push("## Current Todos")
    content.push("")
    content.push(renderAnyBlock(todos))
  }

  if (diff !== null && diff !== undefined) {
    content.push("")
    content.push("## Session Diff")
    content.push("")
    content.push(renderAnyBlock(diff))
  }

  content.push("")
  content.push("## Message Timeline")

  if (messages.length === 0) {
    content.push("")
    content.push("No messages found.")
  } else {
    for (let i = 0; i < messages.length; i += 1) {
      content.push("")
      content.push(renderMessage(messages[i], i))
    }
  }

  content.push("")
  content.push("## Raw Payload Appendix")
  content.push("")
  content.push(renderAnyBlock({ session, messages, todos, diff }))

  return normaliseNewlines(content.join("\n"))
}

async function atomicWrite(filePath: string, content: string): Promise<number> {
  const dirPath = path.dirname(filePath)
  await mkdir(dirPath, { recursive: true })

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const normalised = normaliseNewlines(content)

  await writeFile(tmpPath, normalised, "utf8")

  try {
    await rename(tmpPath, filePath)
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined)
    throw error
  }

  return Buffer.byteLength(normalised, "utf8")
}

async function fetchSessionSnapshot(ctx: UnknownRecord, sessionID: string): Promise<SessionSnapshot> {
  const client = asObject(ctx.client)
  const sessionClient = asObject(client.session)

  const get = sessionClient.get as ((arg: unknown) => Promise<{ data: unknown }>) | undefined
  const messages = sessionClient.messages as ((arg: unknown) => Promise<{ data: unknown }>) | undefined
  const todo = sessionClient.todo as ((arg: unknown) => Promise<{ data: unknown }>) | undefined
  const diff = sessionClient.diff as ((arg: unknown) => Promise<{ data: unknown }>) | undefined

  if (typeof get !== "function" || typeof messages !== "function") {
    throw new Error("Session API unavailable on plugin context")
  }

  const [sessionResult, messagesResult, todoResult, diffResult] = await Promise.all([
    get({ path: { id: sessionID } }),
    messages({ path: { id: sessionID } }),
    typeof todo === "function"
      ? todo({ path: { id: sessionID } }).catch(() => ({ data: null }))
      : Promise.resolve({ data: null }),
    typeof diff === "function"
      ? diff({ path: { id: sessionID } }).catch(() => ({ data: null }))
      : Promise.resolve({ data: null }),
  ])

  const session = asObject(sessionResult?.data)
  if (!session.id) {
    throw new Error(`Session not found for id '${sessionID}'`)
  }

  return {
    session,
    messages: asArray(messagesResult?.data),
    todos: todoResult?.data ?? null,
    diff: diffResult?.data ?? null,
  }
}

function resolveOutputRoot(ctx: UnknownRecord): string {
  const worktree = asString(ctx.worktree, "")
  if (worktree && worktree !== "/") return worktree

  const directory = asString(ctx.directory, "")
  if (directory) return directory

  return process.cwd()
}

function resolveOutputPath(snapshot: SessionSnapshot, outputRoot: string): string {
  const session = snapshot.session
  const time = asObject(session.time)
  const created = time.created ?? session.createdAt ?? session.created_at
  const timestamp = formatFilenameTimestamp(created)
  const id = sanitiseFilename(asString(session.id, "unknown-session"))

  return path.join(outputRoot, "convos", `${timestamp}-${id}.md`)
}

async function logEvent(ctx: UnknownRecord, level: string, message: string, extra: UnknownRecord = {}): Promise<void> {
  const client = asObject(ctx.client)
  const app = asObject(client.app)
  const logger = app.log as ((arg: unknown) => Promise<unknown>) | undefined
  if (typeof logger !== "function") return

  await logger({
    body: {
      service: SERVICE_NAME,
      level,
      message,
      ...extra,
    },
  }).catch(() => undefined)
}

export const ConvoDumpPlugin = async (ctx: UnknownRecord) => {
  const state = new Map<string, SessionState>()
  const debug = process.env.OPENCODE_CONVODUMP_DEBUG === "1" || process.env.OPENCODE_CONVODUMP_DEBUG === "true"
  const outputRoot = resolveOutputRoot(ctx)

  function sessionState(sessionID: string): SessionState {
    const existing = state.get(sessionID)
    if (existing) return existing

    const created: SessionState = { queue: Promise.resolve() }
    state.set(sessionID, created)
    return created
  }

  function schedule(sessionID: string, trigger: string): void {
    const entry = sessionState(sessionID)
    entry.pendingTrigger = trigger

    if (entry.timer) clearTimeout(entry.timer)

    entry.timer = setTimeout(() => {
      const enqueueTrigger = entry.pendingTrigger ?? trigger
      entry.pendingTrigger = undefined

      entry.queue = entry.queue
        .then(async () => {
          const start = Date.now()
          await logEvent(ctx, "info", "export.started", { sessionID, trigger: enqueueTrigger })

          const snapshot = await fetchSessionSnapshot(ctx, sessionID)
          const fingerprint = snapshotFingerprint(snapshot)
          if (entry.lastFingerprint === fingerprint) {
            await logEvent(ctx, "info", "export.skipped.unchanged", {
              sessionID,
              trigger: enqueueTrigger,
              duration_ms: Date.now() - start,
            })
            return
          }

          const filePath = resolveOutputPath(snapshot, outputRoot)
          const markdown = renderMarkdown(snapshot, enqueueTrigger, ctx)
          const bytes = await atomicWrite(filePath, markdown)

          entry.lastWriteAt = Date.now()
          entry.lastFingerprint = fingerprint
          await logEvent(ctx, "info", "export.completed", {
            sessionID,
            trigger: enqueueTrigger,
            filePath,
            bytes,
            duration_ms: Date.now() - start,
            last_write_at: entry.lastWriteAt,
          })
        })
        .catch(async (error) => {
          await logEvent(ctx, "error", "export.failed", {
            sessionID,
            trigger: enqueueTrigger,
            error: asString((error as Error)?.stack ?? (error as Error)?.message ?? error),
          })
        })
    }, DEBOUNCE_MS)

    if (typeof (entry.timer as { unref?: () => void }).unref === "function") {
      ;(entry.timer as { unref: () => void }).unref()
    }
  }

  return {
    event: async ({ event }: { event: UnknownRecord }) => {
      try {
        const type = asString(event.type)
        const sessionID = resolveSessionIdFromEvent(event)
        if (!sessionID) return

        if (type === "session.status") {
          const status = asObject(asObject(event.properties).status)
          if (status.type === "idle") {
            schedule(sessionID, "session.status:idle")
          }
          return
        }

        if (type === "session.idle") {
          schedule(sessionID, "session.idle")
          return
        }

        if (debug && (type === "message.updated" || type === "message.part.updated")) {
          await logEvent(ctx, "debug", "event.observed", { type, sessionID })
        }
      } catch (error) {
        await logEvent(ctx, "error", "event.handler.failed", {
          error: asString((error as Error)?.stack ?? (error as Error)?.message ?? error),
        })
      }
    },
  }
}

export default ConvoDumpPlugin
