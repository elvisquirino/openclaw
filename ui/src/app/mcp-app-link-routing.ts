import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { ApplicationContext } from "./context.ts";

export function looksLikeMcpAppLink(href: string): boolean {
  return /^(?:(?:codex|chatgpt|openclaw):\/\/plugins\/|https:\/\/chatgpt\.com\/plugins\/)/iu.test(
    href,
  );
}

export function startMcpAppRouting(context: Pick<ApplicationContext, "navigate">) {
  let disposed = false;
  const click = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event)) {
      return;
    }
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
    if (!anchor || anchor.hasAttribute("download")) {
      return;
    }
    const href = anchor.href;
    if (!looksLikeMcpAppLink(href)) {
      return;
    }
    // Chat links use target=_blank by default. Malformed plugin links that pass
    // this probe are dropped if strict parsing fails, rather than opening a browser.
    event.preventDefault();
    void import("./mcp-app-routing.ts")
      .then(({ navigateMcpAppLink }) => {
        if (!disposed) {
          navigateMcpAppLink(context, href);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error("[openclaw] MCP app link failed to load; click to retry", error);
        }
      });
  };
  document.addEventListener("click", click);
  return {
    dispose: () => {
      disposed = true;
      document.removeEventListener("click", click);
    },
  };
}
