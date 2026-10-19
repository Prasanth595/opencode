import { createSignal, lazy, Show, Suspense } from "solid-js"
import { Command, Slot, TitlebarItem, type Setup } from "../sdk"
import type Debug from "./index"

const setup: Setup<typeof Debug> = (ctx) => {
  const DebugBar = lazy(() => import("./bar"))
  const Motion = lazy(() => import("./motion"))
  const channel = ctx.build.channel
  // Window-local; every window starts with the bar hidden.
  const [visible, setVisible] = createSignal(false)

  const [motion, setMotion] = createSignal(false)

  const toggle = () => {
    setVisible((value) => !value)
  }

  const toggleMotion = () => {
    setMotion((value) => !value)
  }

  // Motion tuning is a dev-server tool: no built app (dev, beta or prod channel) ships its button or panel.
  const motionTools = import.meta.env.DEV

  ctx.add(
    Command,
    (): Command => ({
      id: "toggle",
      title: ctx.t("command.toggle"),
      group: ctx.t("command.category.view"),
      run: toggle,
    }),
  )

  if (motionTools)
    ctx.add(
      Command,
      (): Command => ({
        id: "motion",
        title: ctx.t("command.motion"),
        group: ctx.t("command.category.view"),
        run: toggleMotion,
      }),
    )

  ctx.add(Slot, {
    at: "window.bottom",
    render: () => (
      <>
        <Show when={visible()}>
          <Suspense>
            <DebugBar
              diagnostics={import.meta.env.DEV}
              motion={motionTools ? { open: motion(), toggle: toggleMotion } : undefined}
              inline
            />
          </Suspense>
        </Show>
        <Show when={motionTools}>
          <Suspense>
            <Motion open={motion()} button={!visible()} toggle={toggleMotion} title={ctx.t("motion.title")} />
          </Suspense>
        </Show>
      </>
    ),
  })

  if (channel !== "dev" && channel !== "local") return
  ctx.add(
    TitlebarItem,
    (): TitlebarItem => ({
      id: "toggle",
      placement: "channel",
      label: ctx.t("status.toggle"),
      pressed: visible(),
      run: toggle,
    }),
  )
}

export default setup
