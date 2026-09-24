/** Mounts review components against a real store backed by the fake daemon API. */
import type { ComponentChildren } from "preact";
import { render } from "preact";
import { act } from "preact/test-utils";
import { AppContext, createActions } from "../../../src/client/app/actions.js";
import { createUi } from "../../../src/client/app/ui.js";
import { fakeApi, makeStore } from "../store/fakes.js";

export async function mount(children: ComponentChildren, api = fakeApi()) {
  const { store } = makeStore(api);
  await store.start();
  const ui = createUi();
  const app = { store, ui, actions: createActions(store, ui) };
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  await act(() => {
    render(<AppContext.Provider value={app}>{children}</AppContext.Provider>, root);
  });
  return { app, api, root };
}

export function button(root: ParentNode, label: string | RegExp): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""),
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

export async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

export async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function settle(fn: () => void = () => {}) {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
}
