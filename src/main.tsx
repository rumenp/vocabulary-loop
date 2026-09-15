import { render } from "preact";
import { App } from "./App";
import "./styles.css";
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });
render(<App />, document.getElementById("app")!);

