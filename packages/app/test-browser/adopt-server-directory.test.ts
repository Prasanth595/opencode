import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { serverState } from "@/runtime/server/persistence"
import { adoptServerDirectory, createServerProjects, ServerConnection } from "@/runtime/server/registry"
import { ServerScope } from "@/runtime/server/scope"

const dir = "/srv/repo"

const other = "/other"

const events = ["hydrate", "connect", "disconnect", "resolve", "close", "remove", "openOther", "closeOther"] as const

type Event = (typeof events)[number]

type Model = { hydrated: boolean; connected: boolean; pending: boolean; list: string[]; closed: string[] }

const saved = {
  empty: { list: [], closed: [] },
  other: { list: [other], closed: [] },
  closed: { list: [], closed: [dir] },
  open: { list: [dir], closed: [] },
} satisfies Record<string, { list: string[]; closed: string[] }>

function projectsFor(server: string) {
  const schema = Persistence.withInitial(serverState(), {
    list: [],
    hidden: {},
    projects: {},
    lastProject: {},
    recentlyClosed: {},
  })

  const [store, setStore] = createStore(Schema.decodeUnknownSync(schema)({}))
  const scope = ServerScope.fromServerKey(ServerConnection.Key.make(server))

  return { store, projects: createServerProjects({ store, setStore, scope: () => scope }) }
}

function sequences(maxLength: number) {
  const all: Event[][] = [[]]

  for (let length = 1; length <= maxLength; length++) {
    for (const prefix of all.filter((sequence) => sequence.length === length - 1)) {
      for (const event of events) all.push([...prefix, event])
    }
  }

  return all
}

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

function setup() {
  const { projects } = projectsFor("https://a.example")
  const [hydrated, setHydrated] = createSignal(false)
  const [connected, setConnected] = createSignal(false)

  const dispose = createRoot((dispose) => {
    adoptServerDirectory({ hydrated, connected, location: async () => ({ directory: dir }), adopt: projects.adopt })

    return dispose
  })

  return { projects, setHydrated, setConnected, dispose }
}

test("adopts nothing until stored projects have loaded", async () => {
  const { projects, setConnected, dispose } = setup()

  setConnected(true)
  await flush()
  expect(projects.list()).toEqual([])
  dispose()
})

test("adopts the directory once loaded and connected", async () => {
  const { projects, setHydrated, setConnected, dispose } = setup()

  setHydrated(true)
  setConnected(true)
  await flush()
  expect(projects.list()).toEqual([{ worktree: dir, expanded: true }])
  dispose()
})

test("does not adopt the directory again after the user closes it and reconnects", async () => {
  const { projects, setHydrated, setConnected, dispose } = setup()

  setHydrated(true)
  setConnected(true)
  await flush()
  projects.close(dir)
  setConnected(false)
  setConnected(true)
  await flush()
  expect(projects.list()).toEqual([])
  dispose()
})

test("does not adopt when stored projects exist", async () => {
  const { projects, setHydrated, setConnected, dispose } = setup()

  projects.open(other)
  setHydrated(true)
  setConnected(true)
  await flush()
  expect(projects.list()).toEqual([{ worktree: other, expanded: true }])
  dispose()
})

// Every sequence of up to four events, from each saved state, against a model of the intended behavior:
// becoming ready (stored projects loaded and connected) fetches the location; when the latest fetch
// resolves while still ready, the directory is adopted only if no project is open and the user did not close it.
test("adoptServerDirectory matches the model for every short event sequence", async () => {
  for (const [name, initial] of Object.entries(saved)) {
    for (const sequence of sequences(4)) {
      const { store, projects } = projectsFor("https://a.example")
      const [hydrated, setHydrated] = createSignal(false)
      const [connected, setConnected] = createSignal(false)
      const model: Model = { hydrated: false, connected: false, pending: false, list: [], closed: [] }
      const ready = () => model.hydrated && model.connected
      const fetches: Array<() => void> = []

      const dispose = createRoot((dispose) => {
        adoptServerDirectory({
          hydrated,
          connected,
          location: () => new Promise((resolve) => fetches.push(() => resolve({ directory: dir }))),
          adopt: projects.adopt,
        })

        return dispose
      })

      for (const event of sequence) {
        const wasReady = ready()

        // The UI acts on projects only once stored projects have loaded.
        if (!model.hydrated && ["close", "remove", "openOther", "closeOther"].includes(event)) continue

        if (event === "hydrate" && !model.hydrated) {
          expect(store.projects).toEqual({})

          for (const worktree of [...initial.list].reverse()) projects.open(worktree)

          for (const worktree of [...initial.closed].reverse()) projects.close(worktree)

          model.list = [...initial.list]
          model.closed = [...initial.closed]
          model.hydrated = true
          setHydrated(true)
        }

        if (event === "connect" || event === "disconnect") {
          model.connected = event === "connect"
          setConnected(model.connected)
        }

        if (event === "close" && model.list.includes(dir)) {
          projects.close(dir)
          model.list = model.list.filter((worktree) => worktree !== dir)
          model.closed = [dir, ...model.closed.filter((worktree) => worktree !== dir)]
        }

        if (event === "remove") {
          projects.remove(dir)
          model.list = model.list.filter((worktree) => worktree !== dir)
        }

        if (event === "openOther") {
          projects.open(other)
          model.closed = model.closed.filter((worktree) => worktree !== other)

          if (!model.list.includes(other)) model.list = [other, ...model.list]
        }

        if (event === "closeOther" && model.list.includes(other)) {
          projects.close(other)
          model.list = model.list.filter((worktree) => worktree !== other)
          model.closed = [other, ...model.closed.filter((worktree) => worktree !== other)]
        }

        if (event === "resolve") {
          for (const resolve of fetches.splice(0)) resolve()

          if (model.pending && model.list.length === 0 && !model.closed.includes(dir)) model.list = [dir]

          model.pending = false
        }

        if (!wasReady && ready()) model.pending = true

        if (wasReady && !ready()) model.pending = false

        await flush()

        const label = `${name}: ${sequence.join(" > ")} @ ${event}`

        expect({ label, list: projects.list().map((project) => project.worktree) }).toEqual({ label, list: model.list })
        expect({ label, closed: projects.recentlyClosed() }).toEqual({ label, closed: model.closed })
      }

      dispose()
    }
  }
})
