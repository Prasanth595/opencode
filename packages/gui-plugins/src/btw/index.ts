import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"
import en from "./i18n/en"

const Chats = Schema.Struct({
  chats: Schema.Array(
    Schema.Struct({ id: Schema.String, question: Schema.String, answer: Schema.optional(Schema.String) }),
  ),
})

export default Plugin.define({
  id: "btw",
  stores: {
    // Each open /btw tab's chat (its question and answer), kept until its tab closes.
    chats: Store.session(Chats, { chats: [] }),
  },
  i18n: { en },
})
