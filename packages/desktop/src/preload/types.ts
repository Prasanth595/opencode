import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"
import type { ProviderKeyValidation } from "../main/validation/provider-key"

export type ElectronNative = {
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  extensions: Promise<WindowSnapshot["extensions"]>
  getPathForFile(file: File): string
  validateProviderKey(providerID: string, key: string): Promise<ProviderKeyValidation>
}
