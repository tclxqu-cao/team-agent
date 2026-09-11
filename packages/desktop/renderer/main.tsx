import React from "react";
import ReactDOM from "react-dom/client";
import { SharedServiceRoot } from "./SharedServiceRoot";
import "./styles/global.css";
import "./styles/composer.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SharedServiceRoot />
  </React.StrictMode>,
);
