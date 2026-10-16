import type { ServiceEvent } from "@opencode/schema/service-event"
import { createSignal, For, Show } from "solid-js"
import { SessionQuestion } from "../routes/session/permission"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { useClient } from "./client"
import { useData } from "./data"
import { useEvent } from "./event"
import { createSimpleContext } from "./helper"

export const { use: useRestartApproval, provider: RestartApprovalProvider } =
	createSimpleContext({
		name: "RestartApproval",
		init: () => {
			const client = useClient()
			const dialog = useDialog()
			const event = useEvent()
			const toast = useToast()
			const [active, setActive] = createSignal<ReadonlyArray<string>>([])

			function open(sessions: ReadonlyArray<string>) {
				setActive(sessions)
				dialog.replace(() => (
					<RestartApprovalDialog
						active={active()}
						onSelect={(decision) => void decide(decision)}
					/>
				))
			}

			function close() {
				setActive([])
				dialog.clear()
			}

			async function decide(decision: ServiceEvent.Decision) {
				try {
					await client.api.server.restart.resolve({ decision })
				} catch (error) {
					toast.show({
						title: "Failed to resolve restart",
						message: errorMessage(error),
						variant: "error",
					})
				}
				close()
			}

			event.on("server.restart.requested", (evt) => open(evt.data.active))
			event.on("server.restart.resolved", () => close())

			return { open, close, decide }
		},
	})

function RestartApprovalDialog(props: {
	active: ReadonlyArray<string>
	onSelect: (decision: ServiceEvent.Decision) => void
}) {
	const data = useData()

	return (
		<SessionQuestion
			id="service.restart-approval"
			group="Service"
			choicesLabel="Restart options"
			instance={props.active.join(", ")}
			title="Restart service with running agents?"
			body={
				<box paddingLeft={1} gap={1}>
					<text>
						The following sessions have running agents and would be interrupted:
					</text>
					<box flexDirection="column" paddingLeft={1}>
						<For each={props.active}>
							{(sessionID) => (
								<text>- {data.session.get(sessionID)?.title ?? sessionID}</text>
							)}
						</For>
					</box>
					<Show when={props.active.length === 0}>
						<text>No sessions are running anymore.</text>
					</Show>
				</box>
			}
			options={{
				now: "Restart now",
				idle: "When idle",
				cancel: "Cancel restart",
			}}
			escapeKey="cancel"
			onSelect={(option) => props.onSelect(option)}
		/>
	)
}
