/**
 * Host half of dsh-session-unread-mark: owns the durable unread marks and
 * serves them to every browser through two routes inside Connection's
 * authentication fence (`ctx.connection.fetch`), so only the logged-in owner
 * reaches them and every device sees the same marks.
 *
 *   GET  /api/session-unread-mark.state  -> { ids: { [sessionId]: { armed } } }
 *   POST /api/session-unread-mark.set    <- { changes: [{ id, mark: { armed } | null }] }
 *                                        -> the resulting state, same shape as GET
 *
 * Marks live in one JSON file (default `$DSH_HOME/storages/session-unread-mark.json`,
 * override with the row's `config.file`). Writes are serialized and atomic
 * (temp file + rename); a POST carries per-session changes rather than a whole
 * state, so concurrent devices never overwrite each other's marks.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'session-unread-mark'
export const inject = ['connection']

const STATE_PATH = '/api/session-unread-mark.state'
const SET_PATH = '/api/session-unread-mark.set'
/** Upper bound on stored marks; far above any real session count. */
const MAX_IDS = 20000
/** Upper bound on changes in one request. */
const MAX_CHANGES = 2000
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/
const NO_STORE = { 'cache-control': 'no-store' }

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * One stored mark. `manual` is true when the user chose "mark as unread"
 * (kept until the session is opened again); false for a persisted automatic
 * "finished while away" dot. `armed` is kept only for 0.2 clients.
 */
function normalizeMark(mark) {
  return { armed: mark?.armed !== false, manual: mark?.manual === true }
}

/** Parse the stored or transmitted `{ ids }` shape, dropping malformed entries. */
function parseIds(value) {
  const marks = new Map()
  const ids = value && typeof value === 'object' ? value.ids : undefined
  if (!ids || typeof ids !== 'object' || Array.isArray(ids)) return marks
  for (const [id, mark] of Object.entries(ids)) {
    if (SESSION_ID.test(id)) marks.set(id, normalizeMark(mark))
  }
  return marks
}

function toJson(marks) {
  const ids = {}
  for (const [id, mark] of marks) ids[id] = { armed: mark.armed, manual: mark.manual }
  return { ids }
}

/** Validate one POST body into a change list. */
function parseChanges(body) {
  const changes = body && typeof body === 'object' ? body.changes : undefined
  if (!Array.isArray(changes)) throw new HttpError(400, '`changes` must be an array')
  if (changes.length > MAX_CHANGES) throw new HttpError(413, `at most ${MAX_CHANGES} changes per request`)
  return changes.map((change, index) => {
    const id = change?.id
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new HttpError(400, `changes[${index}].id is not a session id`)
    const mark = change.mark
    if (mark === null) return { id, mark: null }
    if (
      mark && typeof mark === 'object'
      && (mark.armed === undefined || typeof mark.armed === 'boolean')
      && (mark.manual === undefined || typeof mark.manual === 'boolean')
    ) {
      return { id, mark: normalizeMark(mark) }
    }
    throw new HttpError(400, `changes[${index}].mark must be null or { armed?: boolean, manual?: boolean }`)
  })
}

function createStore(file) {
  let marks
  let chain = Promise.resolve()

  /** Run one operation after every earlier one, whatever their outcome. */
  function serial(task) {
    const next = chain.then(task)
    chain = next.catch(() => {})
    return next
  }

  async function load() {
    if (marks !== undefined) return marks
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      marks = new Map()
      return marks
    }
    try {
      marks = parseIds(JSON.parse(text))
    } catch (error) {
      // Keep the unreadable file for inspection instead of overwriting it.
      const aside = `${file}.corrupt-${Date.now()}`
      await rename(file, aside).catch(() => {})
      console.warn(`[session-unread-mark] unreadable ${file}; moved to ${aside}`, error)
      marks = new Map()
    }
    return marks
  }

  async function persist(next) {
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(toJson(next))}\n`, 'utf8')
    await rename(temp, file)
  }

  return {
    read: () => serial(async () => toJson(await load())),
    apply: (changes) => serial(async () => {
      const next = new Map(await load())
      let changed = false
      for (const { id, mark } of changes) {
        if (mark === null) {
          changed = next.delete(id) || changed
        } else if (next.get(id)?.armed !== mark.armed || next.get(id)?.manual !== mark.manual) {
          next.set(id, mark)
          changed = true
        }
      }
      if (next.size > MAX_IDS) throw new HttpError(413, `at most ${MAX_IDS} marks`)
      if (changed) await persist(next)
      marks = next
      return toJson(next)
    }),
  }
}

function failure(error) {
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE })
  console.error('[session-unread-mark] request failed', error)
  return Response.json({ error: 'internal error' }, { status: 500, headers: NO_STORE })
}

export function apply(ctx, config = {}) {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = typeof config?.file === 'string' && config.file !== '' ? config.file : join(base, 'storages', 'session-unread-mark.json')
  const store = createStore(file)

  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try {
        return Response.json(await store.read(), { headers: NO_STORE })
      } catch (error) {
        return failure(error)
      }
    },
  }), 'session-unread-mark: state route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: SET_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        let body
        try {
          body = await request.json()
        } catch {
          throw new HttpError(400, 'body must be JSON')
        }
        return Response.json(await store.apply(parseChanges(body)), { headers: NO_STORE })
      } catch (error) {
        return failure(error)
      }
    },
  }), 'session-unread-mark: set route')
}
