export type Policy = "disable" | "notify" | "auto"
export type Action = "none" | "notify" | "auto"

const maximumComponent = "9007199254740991"
const versionPattern =
  /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function action(current: string, latest: string, policy: Policy): Action {
  if (policy === "disable") return "none"
  const currentVersion = parseReleaseVersion(current)
  const latestVersion = parseReleaseVersion(latest)
  if (!currentVersion || !latestVersion || sameRelease(currentVersion, latestVersion)) return "none"
  return policy
}

export function parseReleaseVersion(input: string) {
  if (input.length > 256) return
  const match = input.trim().match(versionPattern)
  if (!match) return
  if ([match[1], match[2], match[3]].some(invalidComponent)) return
  if (
    match[4]
      ?.split(".")
      .some((identifier) => identifier.length > 1 && identifier.startsWith("0") && /^[0-9]+$/.test(identifier))
  )
    return
  return {
    major: match[1],
    core: `${match[1]}.${match[2]}.${match[3]}`,
    prerelease: match[4]?.split(".") ?? [],
  }
}

/** True when `version` is a strictly newer release than `other` (semver order:
 * core numerically, then prerelease identifiers per semver; unparseable is never newer). */
export function isNewerRelease(version: string, other: string) {
  const left = parseReleaseVersion(version)
  const right = parseReleaseVersion(other)
  if (!left || !right) return false
  return compareRelease(left, right) > 0
}

function compareRelease(
  left: NonNullable<ReturnType<typeof parseReleaseVersion>>,
  right: NonNullable<ReturnType<typeof parseReleaseVersion>>,
) {
  const [majorA, minorA, patchA] = left.core.split(".").map(Number)
  const [majorB, minorB, patchB] = right.core.split(".").map(Number)
  if (majorA !== majorB) return majorA - majorB
  if (minorA !== minorB) return minorA - minorB
  if (patchA !== patchB) return patchA - patchB
  // A release with no prerelease outranks any prerelease of the same core.
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const compared = compareIdentifier(left.prerelease[index], right.prerelease[index])
    if (compared !== 0) return compared
  }
  return left.prerelease.length - right.prerelease.length
}

function compareIdentifier(left: string, right: string) {
  const leftNumeric = /^[0-9]+$/.test(left)
  const rightNumeric = /^[0-9]+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function sameRelease(current: NonNullable<ReturnType<typeof parseReleaseVersion>>, latest: typeof current) {
  if (current.core !== latest.core || current.prerelease.length !== latest.prerelease.length) return false
  return current.prerelease.every((identifier, index) => {
    const other = latest.prerelease[index]
    if (identifier === other) return true
    // semver compares oversized numeric prerelease identifiers after numeric coercion.
    return /^[0-9]+$/.test(identifier) && /^[0-9]+$/.test(other) && Number(identifier) === Number(other)
  })
}

function invalidComponent(value: string) {
  if (value.length > 1 && value.startsWith("0")) return true
  if (value.length !== maximumComponent.length) return value.length > maximumComponent.length
  return value > maximumComponent
}
