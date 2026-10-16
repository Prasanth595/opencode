import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

/**
 * #55670: a launch directory whose location the server cannot resolve -- typically a project
 * configuration error -- used to open the server's default location with nothing shown, so the
 * project's sessions simply looked missing.
 */
test("reports the launch directory the server could not resolve", async () => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/fs/list")
        return json(
          {
            name: "ConfigInvalidError",
            data: {
              path: "opencode.json",
              message: "FileSystem.readFile: ENOENT: no such file or directory",
              issues: [],
            },
          },
          { status: 500 },
        )
      return undefined
    },
  })
  await setup.ready

  await setup.waitForFrame((frame) => frame.includes("Could not open"))
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Could not open")
  expect(frame).toContain("instead")
})

test("says nothing when the launch directory resolves", async () => {
  await using setup = await createAppFixture({})
  await setup.ready

  // The launch probe is awaited before the first frame, so a failure notice would already be up.
  await setup.waitForFrame((frame) => frame.includes("commands"))
  expect(setup.captureCharFrame()).not.toContain("Could not open")
})
