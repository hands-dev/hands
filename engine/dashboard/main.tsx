import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// Stock shadcn dark mode is the `.dark` class; with no theme toggle, mirror
// the OS preference onto the root element.
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", mq.matches);
applyTheme();
mq.addEventListener("change", applyTheme);

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
