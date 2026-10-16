import { onMount } from "solid-js"
import { useLog } from "../context/log"
import { useToast } from "../ui/toast"
import { cliErrorMessage, errorMessage } from "../util/error"

/**
 * Reports the launch directory the server could not resolve. Without this the TUI opens the server's
 * default location and looks like the project simply has no sessions, which is how a configuration
 * error stayed invisible.
 */
export function LaunchLocationFailure(props: { directory: string; fallback: string; cause: unknown }) {
  const log = useLog()
  const toast = useToast()

  onMount(() => {
    if (props.cause === undefined) return
    const reason = cliErrorMessage(props.cause) ?? errorMessage(props.cause)
    log.error("failed to resolve the launch location", { directory: props.directory, reason })
    toast.show({
      variant: "error",
      title: `Could not open ${props.directory}`,
      message: `The server could not resolve it: ${reason}\nOpened ${props.fallback} instead.`,
    })
  })

  return null
}
