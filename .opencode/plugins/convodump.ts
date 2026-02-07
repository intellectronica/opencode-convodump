import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

const SERVICE_NAME = "opencode-convodump"
type UnknownRecord = Record<string, unknown>

type SessionState = {
  queue: Promise<void>
  scheduled?: boolean
  pendingTrigger?: string
  lastWriteAt?: number
  lastFingerprint?: string
  cachedSnapshot?: SessionSnapshot
  prefetching?: Promise<void>
  lastPrefetchAt?: number
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

function bindMethod<T extends (...args: any[]) => any>(target: unknown, key: string): T | null {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return null
  const candidate = (target as Record<string, unknown>)[key]
  if (typeof candidate !== "function") return null
  return candidate.bind(target) as T
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null as T | null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ])
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
  return stableJson({
    session: snapshot.session,
    messages: snapshot.messages,
    todos: snapshot.todos,
    diff: snapshot.diff,
  })
}

function chooseTrigger(existing: string | undefined, incoming: string): string {
  if (!existing) return incoming
  if (existing === "session.status:idle") return existing
  if (incoming === "session.status:idle") return incoming
  return incoming
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

function buildFrontmatter(session: UnknownRecord): UnknownRecord {
  const time = asObject(session.time)

  return {
    session_id: session.id ?? null,
    title: session.title ?? null,
    created_at: toISO(time.created ?? session.createdAt ?? session.created_at),
    updated_at: toISO(time.updated ?? session.updatedAt ?? session.updated_at),
  }
}

function truncateText(value: string, maxChars = 5000): string {
  const normalised = normaliseNewlines(value)
  if (normalised.length <= maxChars) return normalised

  const omitted = normalised.length - maxChars
  return `${normalised.slice(0, maxChars)}\n\n... [truncated ${omitted} chars]`
}

function renderQuoteBlock(value: string, maxChars = 7000): string {
  const text = truncateText(value, maxChars)
  if (text.trim() === "") return ">"

  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n")
}

function renderPlainText(value: string, maxChars = 7000): string {
  return truncateText(value, maxChars).trim()
}

function truncateInlineText(value: string, maxChars: number): string {
  const flattened = normaliseNewlines(value).replace(/\s+/g, " ").trim()
  if (flattened.length <= maxChars) return flattened
  if (maxChars <= 3) return "..."
  return `${flattened.slice(0, maxChars - 3)}...`
}

function compactToolJsonValue(value: unknown, baseLimit: number, depth = 0): unknown {
  if (value === null || value === undefined) return null

  if (typeof value === "string") {
    const maxChars = Math.max(16, baseLimit - depth * 4)
    return truncateInlineText(value, maxChars)
  }

  if (typeof value === "number" || typeof value === "boolean") return value

  if (Array.isArray(value)) {
    const limit = 16
    const items = value.slice(0, limit).map((item) => compactToolJsonValue(item, baseLimit, depth + 1))
    if (value.length > limit) {
      items.push(`... (${value.length - limit} more items)`)
    }
    return items
  }

  if (typeof value === "object") {
    const entries = Object.entries(asObject(value))
    const limit = 24
    const result: UnknownRecord = {}

    for (const [key, child] of entries.slice(0, limit)) {
      result[key] = compactToolJsonValue(child, baseLimit, depth + 1)
    }

    if (entries.length > limit) {
      result._truncated = `${entries.length - limit} additional keys`
    }

    return result
  }

  return asString(value)
}

function formatToolCallJson(value: UnknownRecord): string {
  for (const limit of [56, 48, 40, 32, 24]) {
    const compact = compactToolJsonValue(value, limit)
    const rendered = JSON.stringify(compact, null, 2)
    if (rendered.split("\n").every((line) => line.length <= 80)) {
      return rendered
    }
  }

  return JSON.stringify(compactToolJsonValue(value, 20), null, 2)
}

function renderCompactJson(value: unknown, maxChars = 3200): string {
  const raw = typeof value === "string" ? value : stableJson(value)
  const language = typeof value === "string" ? "text" : "json"
  return renderCodeBlock(truncateText(raw, maxChars), language)
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === "string") return value.trim() !== ""
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(asObject(value)).length > 0
  return true
}

function formatRole(role: string): string {
  if (!role) return "Unknown"
  if (role.toLowerCase() === "assistant") return "Agent"
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`
}

function renderPart(part: UnknownRecord): string {
  const type = asString(part.type, "unknown")
  const section: string[] = []

  if (type === "text") {
    const text = renderPlainText(asString(part.text ?? part.content, ""))
    if (text) section.push(text)

    const flags: string[] = []
    if (part.synthetic === true) flags.push("synthetic")
    if (part.ignored === true) flags.push("ignored")
    if (flags.length > 0) {
      section.push("")
      section.push(`_(${flags.join(", ")})_`)
    }
  } else if (type === "reasoning") {
    const thinking = asString(part.text ?? part.reasoning ?? part.content, "")
    if (thinking.trim() !== "") {
      section.push(renderQuoteBlock(thinking, 12000))
    }
  } else if (type === "tool") {
    const state = asObject(part.state)
    const toolInput = part.input ?? part.arguments ?? part.args ?? state.input ?? null
    const toolResult = part.output ?? part.result ?? state.output
    const toolError = part.error ?? state.error
    const toolAttachments = part.attachments ?? state.attachments

    const outputPayload: UnknownRecord = {}
    if (hasContent(toolResult)) outputPayload.result = toolResult
    if (hasContent(toolError)) outputPayload.error = toolError
    if (hasContent(toolAttachments)) outputPayload.attachments = toolAttachments

    const toolCall: UnknownRecord = {
      tool: asString(part.tool ?? part.name ?? part.toolName, "unknown"),
      input: toolInput,
      output: Object.keys(outputPayload).length > 0 ? outputPayload : null,
    }

    section.push(renderCodeBlock(formatToolCallJson(toolCall), "json"))
  } else if (type === "file") {
    section.push(`File \`${asString(part.filename ?? part.name, "unknown")}\` (${asString(part.mime ?? part.mimeType, "unknown")})`)
    if (part.url) section.push(`- URL: ${asString(part.url)}`)
    if (part.source !== undefined) {
      section.push("- Source:")
      section.push(renderCompactJson(part.source, 1800))
    }
  } else if (type === "subtask") {
    section.push(`Subtask \`${asString(part.agent, "unknown")}\` (${asString(part.model, "unknown")})`)

    const command = asString(part.command, "")
    if (command) section.push(`- Command: \`${command}\``)

    if (part.description !== undefined) {
      section.push("")
      section.push("Description:")
      section.push(renderQuoteBlock(asString(part.description, ""), 6000))
    }

    if (part.prompt !== undefined) {
      section.push("")
      section.push("Prompt:")
      section.push(renderQuoteBlock(asString(part.prompt, ""), 6000))
    }
  } else if (type === "step-start" || type === "step-finish") {
    return ""
  } else {
    section.push(`${type}:`)
    section.push("")
    section.push("Details:")
    section.push(renderCompactJson(part, 2200))
  }

  return section.join("\n")
}

function renderMessage(message: unknown, index: number): string {
  const msg = asObject(message)
  const parts = asArray(msg.parts)
  const role = getMessageRole(msg)
  void index

  const section: string[] = []
  section.push(`### ${formatRole(role)}`)
  section.push("")

  if (parts.length === 0) {
    section.push("_No content._")
    return section.join("\n")
  }

  let hasRenderedPart = false

  for (let i = 0; i < parts.length; i += 1) {
    const renderedPart = renderPart(asObject(parts[i]))
    if (!renderedPart) continue

    if (hasRenderedPart) section.push("")
    section.push(renderedPart)
    hasRenderedPart = true
  }

  if (!hasRenderedPart) {
    section.push("_No content._")
  }

  return section.join("\n")
}

function renderMarkdown(snapshot: SessionSnapshot, trigger: string, ctx: UnknownRecord): string {
  const session = snapshot.session
  const messages = snapshot.messages

  void trigger
  void ctx

  const frontmatter = buildFrontmatter(session)

  const content: string[] = []
  content.push("---")
  content.push(toYaml(frontmatter))
  content.push("---")

  if (messages.length === 0) {
    content.push("")
    content.push("_No messages yet._")
  } else {
    for (let i = 0; i < messages.length; i += 1) {
      if (i > 0) {
        content.push("")
        content.push("---")
      }

      content.push("")
      content.push(renderMessage(messages[i], i))
    }
  }

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
  const sessionClient = client.session

  const get = bindMethod<(arg: unknown) => Promise<{ data: unknown }>>(sessionClient, "get")
  const messages = bindMethod<(arg: unknown) => Promise<{ data: unknown }>>(sessionClient, "messages")
  const todo = bindMethod<(arg: unknown) => Promise<{ data: unknown }>>(sessionClient, "todo")
  const diff = bindMethod<(arg: unknown) => Promise<{ data: unknown }>>(sessionClient, "diff")

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

function resolveOutputRoot(ctx: UnknownRecord, session: UnknownRecord): string {
  const sessionWorktree = asString(session.worktree, "")
  if (sessionWorktree && sessionWorktree !== "/") return sessionWorktree

  const ctxWorktree = asString(ctx.worktree, "")
  if (ctxWorktree && ctxWorktree !== "/") return ctxWorktree

  const sessionDirectory = asString(session.directory, "")
  if (sessionDirectory) return sessionDirectory

  const ctxDirectory = asString(ctx.directory, "")
  if (ctxDirectory) return ctxDirectory

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
  const logger = bindMethod<(arg: unknown) => Promise<unknown>>(client.app, "log")

  if (typeof logger === "function") {
    await logger({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        ...extra,
      },
    }).catch(() => undefined)
    return
  }

  if (level === "error" || process.env.OPENCODE_CONVODUMP_DEBUG === "1" || process.env.OPENCODE_CONVODUMP_DEBUG === "true") {
    const serialised = Object.keys(extra).length > 0 ? ` ${stableJson(extra)}` : ""
    console.error(`[${SERVICE_NAME}] ${level} ${message}${serialised}`)
  }
}

export const ConvoDumpPlugin = async (ctx: UnknownRecord) => {
  const state = new Map<string, SessionState>()
  const debug = process.env.OPENCODE_CONVODUMP_DEBUG === "1" || process.env.OPENCODE_CONVODUMP_DEBUG === "true"

  if (debug) {
    const sessionClient = asObject(ctx.client).session
    console.error(
      `[${SERVICE_NAME}] init hasGet=${String(Boolean(bindMethod(sessionClient, "get")))} hasMessages=${String(Boolean(bindMethod(sessionClient, "messages")))} hasTodo=${String(Boolean(bindMethod(sessionClient, "todo")))} hasDiff=${String(Boolean(bindMethod(sessionClient, "diff")))}`,
    )
  }

  function sessionState(sessionID: string): SessionState {
    const existing = state.get(sessionID)
    if (existing) return existing

    const created: SessionState = { queue: Promise.resolve() }
    state.set(sessionID, created)
    return created
  }

  function schedule(sessionID: string, trigger: string): void {
    const entry = sessionState(sessionID)
    entry.pendingTrigger = chooseTrigger(entry.pendingTrigger, trigger)
    if (debug) {
      console.error(`[${SERVICE_NAME}] schedule session=${sessionID} trigger=${trigger} pending=${entry.pendingTrigger}`)
    }

    if (entry.scheduled) return
    entry.scheduled = true

    entry.queue = entry.queue
      .then(async () => {
        const enqueueTrigger = entry.pendingTrigger ?? trigger
        entry.pendingTrigger = undefined

        const hold = setInterval(() => undefined, 50)
        const start = Date.now()
        try {
          if (debug) {
            console.error(`[${SERVICE_NAME}] export begin session=${sessionID} trigger=${enqueueTrigger}`)
          }
          void logEvent(ctx, "info", "export.started", { sessionID, trigger: enqueueTrigger })

          let snapshot = entry.cachedSnapshot
          if (snapshot) {
            const refreshed = await withTimeout(fetchSessionSnapshot(ctx, sessionID), 120)
            if (refreshed) {
              snapshot = refreshed
              entry.cachedSnapshot = refreshed
            } else if (debug) {
              console.error(`[${SERVICE_NAME}] export refresh timed out, using cached snapshot session=${sessionID}`)
            }
          } else {
            snapshot = await fetchSessionSnapshot(ctx, sessionID)
            entry.cachedSnapshot = snapshot
          }

          if (!snapshot) {
            throw new Error(`No snapshot available for session '${sessionID}'`)
          }

          const fingerprint = snapshotFingerprint(snapshot)
          if (entry.lastFingerprint === fingerprint) {
            if (debug) {
              console.error(`[${SERVICE_NAME}] export skipped unchanged session=${sessionID}`)
            }
            void logEvent(ctx, "info", "export.skipped.unchanged", {
              sessionID,
              trigger: enqueueTrigger,
              duration_ms: Date.now() - start,
            })
            return
          }

          const outputRoot = resolveOutputRoot(ctx, snapshot.session)
          const filePath = resolveOutputPath(snapshot, outputRoot)
          const markdown = renderMarkdown(snapshot, enqueueTrigger, ctx)
          const bytes = await atomicWrite(filePath, markdown)

          entry.lastWriteAt = Date.now()
          entry.lastFingerprint = fingerprint
          if (debug) {
            console.error(`[${SERVICE_NAME}] export wrote session=${sessionID} file=${filePath} bytes=${bytes}`)
          }
          void logEvent(ctx, "info", "export.completed", {
            sessionID,
            trigger: enqueueTrigger,
            filePath,
            bytes,
            duration_ms: Date.now() - start,
            last_write_at: entry.lastWriteAt,
          })
        } finally {
          clearInterval(hold)
          entry.scheduled = false
          if (entry.pendingTrigger) {
            schedule(sessionID, entry.pendingTrigger)
          }
        }
      })
      .catch(async (error) => {
        entry.scheduled = false
        const errorMessage = asString((error as Error)?.stack ?? (error as Error)?.message ?? error)
        if (debug) {
          console.error(`[${SERVICE_NAME}] export failed session=${sessionID} error=${errorMessage}`)
        }
        void logEvent(ctx, "error", "export.failed", {
          sessionID,
          trigger: entry.pendingTrigger ?? trigger,
          error: errorMessage,
        })

        if (entry.pendingTrigger) {
          schedule(sessionID, entry.pendingTrigger)
        }
      })
  }

  function prefetchSnapshot(sessionID: string, reason: string): void {
    const entry = sessionState(sessionID)
    const now = Date.now()

    if (entry.prefetching) return
    if (entry.lastPrefetchAt && now - entry.lastPrefetchAt < 300) return

    entry.lastPrefetchAt = now
    entry.prefetching = fetchSessionSnapshot(ctx, sessionID)
      .then((snapshot) => {
        entry.cachedSnapshot = snapshot
        if (debug) {
          console.error(`[${SERVICE_NAME}] prefetched session=${sessionID} reason=${reason}`)
        }
      })
      .catch((error) => {
        if (debug) {
          console.error(`[${SERVICE_NAME}] prefetch failed session=${sessionID} reason=${reason} error=${asString((error as Error)?.message ?? error)}`)
        }
      })
      .finally(() => {
        entry.prefetching = undefined
      })
  }

  return {
    event: async (payload: unknown) => {
      try {
        const payloadObject = asObject(payload)
        const nestedEvent = asObject(payloadObject.event)
        const event = Object.keys(nestedEvent).length > 0 ? nestedEvent : payloadObject

        const type = asString(event.type)
        const sessionID = resolveSessionIdFromEvent(event)
        if (debug) {
          console.error(`[${SERVICE_NAME}] event type=${type} sessionID=${sessionID ?? ""}`)
        }
        if (!sessionID) return

        if (type === "session.status") {
          const status = asObject(asObject(event.properties).status)
          if (debug) {
            console.error(`[${SERVICE_NAME}] session.status state=${asString(status.type, "unknown")}`)
          }
          const statusType = asString(status.type)
          if (statusType === "busy" || statusType === "retry") {
            prefetchSnapshot(sessionID, `session.status:${statusType}`)
          }
          if (status.type === "idle") {
            schedule(sessionID, "session.status:idle")
          }
          return
        }

        if (type === "session.idle") {
          schedule(sessionID, "session.idle")
          return
        }

        if (type === "session.diff" || type === "todo.updated") {
          prefetchSnapshot(sessionID, type)
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
