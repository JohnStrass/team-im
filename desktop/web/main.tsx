/**
 * Browser entry point. Mounts the same App the Electron client uses, against
 * the HTTP/SSE bridge instead of the Electron preload.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "../renderer/App";
import "../renderer/styles.css";
import { createWebBridge } from "./bridge";

window.teamIm = createWebBridge({
  // Served from the room server itself, so same-origin. Override for dev.
  baseUrl: import.meta.env.VITE_TEAM_IM_SERVER ?? "",
  askIdentity: (seen) => {
    // The bridge already guards against this throwing, but be explicit: some
    // browsers refuse prompt() entirely, and that must degrade to "post as the
    // default and let the user change it", never to a client that will not open.
    if (typeof window.prompt !== "function") return null;
    const handle = window.prompt(
      "Post to the room as:\n\n(The room has no passwords - this only labels your messages.)",
      "",
    )?.trim();
    if (!handle) return null;
    // Free text, because there is no auth to protect and blocking new handles
    // would force a real newcomer to impersonate someone. But an unseen handle
    // is usually a typo, and handles are load-bearing for task claims.
    if (!seen.includes(handle)) {
      const ok = window.confirm(
        `"${handle}" has not posted in this room before.\n\nUse it anyway?`,
      );
      if (!ok) return null;
    }
    return handle;
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
