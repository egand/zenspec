import { render } from "preact";
import "./app/app.css";
import { DocPage } from "./app/DocPage.js";
import { InboxPage } from "./app/InboxPage.js";
import { parseRoute } from "./app/route.js";

function App() {
  const route = parseRoute(location.pathname);
  if (route.page === "doc") return <DocPage address={route.address} />;
  return <InboxPage />;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
