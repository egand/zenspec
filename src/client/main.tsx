import { render } from "preact";

function App() {
  return <main class="zen-app">ZenSpec</main>;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
