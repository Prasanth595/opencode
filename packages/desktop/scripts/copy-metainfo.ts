import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "ai.ember.desktop" : `ai.ember.desktop.${channel}`

const productName = channel === "prod" ? "Ember" : `Ember ${channel.charAt(0).toUpperCase() + channel.slice(1)}`

const summary = `Open source AI assistant${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="ai.auralys">
    <name>Auralys AI</name>
  </developer>

  <description>
    <p>
      Ember is an open source AI assistant that helps you write and run code with any AI model.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/sammyjain95/opencode/issues</url>
  <url type="homepage">https://auralys.ai</url>
  <url type="vcs-browser">https://github.com/sammyjain95/opencode</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
