import { expect, test, type Page } from "@playwright/test"
import { SERVER, sessionHref, session, provider, project, T0, pageMessagesFrom } from "../utils/app"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { installSseTransport, type SseTransport } from "../utils/sse-transport"
import type { OpenCodeEvent } from "@opencode/client/promise"

const directory = "/projects/restart-refetch"

const projectID = "proj_restart_refetch"

const sessionID = "ses_restart_refetch"

const firstMessageID = "msg_restart_first"

const secondMessageID = "msg_restart_second"

const baseSession = () => session({ id: sessionID, projectID, directory, title: "Restart refetch", version: "dev" })

// Each call serves its own mutable message catalog, so a restart can serve a transcript
// that differs from the one the tab already holds.
function mockSessionServer(page: Page, input: { messages: string[] } & Partial<MockServerConfig>) {
  return mockOpenCodeServer(page, {
    directory,
    project: project({ id: projectID, directory }),
    provider: provider({ id: "opencode-model", name: "OpenCode Model" }),
    sessions: [baseSession()],
    pageMessages: pageMessagesFrom({
      [sessionID]: input.messages.map((text, index) => ({
        id: index === 0 ? firstMessageID : secondMessageID,
        type: "user" as const,
        text,
        time: { created: T0 + 1 + index },
      })),
    }),
    ...input,
  })
}

async function openSession(page: Page) {
  const transport = await installSseTransport(page, { server: SERVER })
  await page.goto(sessionHref(sessionID))
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()

  return transport
}

// Drops the event stream the way a server restart does and resolves once the client's
// reconnect loop has opened a fresh stream that answered with server.connected again.
async function restartServer(transport: SseTransport<OpenCodeEvent>) {
  const current = await transport.waitForConnection()
  await transport.disconnect()
  await transport.waitForConnection({ after: current.id })
}

test("timeline refetches messages after the event stream reconnects to a restarted server", async ({ page }) => {
  await mockSessionServer(page, { messages: ["Before the restart"] })
  const transport = await openSession(page)
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${firstMessageID}"]`)).toBeVisible()

  // The server restarts: the SSE stream drops and the mocked server comes back serving a
  // transcript that differs from the one this tab already loaded.
  await mockSessionServer(page, { messages: ["Before the restart", "Turn served only after the restart"] })
  await restartServer(transport)

  // The reconnected stream delivered a fresh server.connected; the open tab must refetch the
  // session transcript instead of holding its pre-restart view.
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${secondMessageID}"]`)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${firstMessageID}"]`)).toBeVisible()
})

test("session list refetches after the event stream reconnects to a restarted server", async ({ page }) => {
  await mockSessionServer(page, { messages: ["Before the restart"] })
  const transport = await openSession(page)
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${firstMessageID}"]`)).toBeVisible()

  // The restarted server's session catalog answers with a changed title.
  const restarted = baseSession()
  restarted.title = "Renamed while the tab was disconnected"
  await mockSessionServer(page, { messages: ["Before the restart"], sessions: [restarted] })

  const sessionListFetch = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/session" && request.method() === "GET",
    { timeout: 15_000 },
  )

  await restartServer(transport)
  await sessionListFetch

  await expect(page.getByText("Renamed while the tab was disconnected").first()).toBeVisible()
})

// The reboot window takes every in-flight refetch down with it: a transcript read that ran into
// the outage must not leave the pane empty once the server is back and the stream reconnected.
test("transcript recovers when the refetch races the restart and fails", async ({ page }) => {
  await mockSessionServer(page, { messages: ["Before the restart"] })
  const transport = await openSession(page)
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${firstMessageID}"]`)).toBeVisible()

  // The restarted server is briefly unable to serve the transcript: the first post-restart
  // transcript read fails outright (the outage swallowed it), and any later read succeeds.
  let failedOnce = false

  await page.route("**/api/session/*/message**", async (route) => {
    const url = new URL(route.request().url())

    if (url.pathname !== `/api/session/${sessionID}/message`) return route.fallback()

    if (failedOnce) return route.fallback()
    failedOnce = true

    return route.abort("failed")
  })

  const failedRead = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/session/${sessionID}/message`,
    { timeout: 15_000 },
  )

  await restartServer(transport)
  await failedRead

  // The client must retry the transcript on its own instead of leaving the pane empty while
  // /api/event and the session title keep working.
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${firstMessageID}"]`)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.locator('[data-component="composer-editor"]')).toBeEditable()
})

// Worst case: the outage swallowed the transcript refetch and no later read succeeds. The tab
// must reload rather than keep showing an empty pane under a live session title.
test("reloads the tab when the post-restart transcript refetch never succeeds", async ({ page }) => {
  await mockSessionServer(page, { messages: ["Before the restart"] })
  const transport = await openSession(page)
  await expect(page.locator(`[data-timeline-row="UserMessage"][data-message-id="${firstMessageID}"]`)).toBeVisible()

  await page.route("**/api/session/*/message**", (route) => {
    const url = new URL(route.request().url())

    return url.pathname === `/api/session/${sessionID}/message` ? route.abort("failed") : route.fallback()
  })
  const reloaded = page.waitForEvent("framenavigated", { timeout: 30_000 })
  await restartServer(transport)

  await reloaded
})
