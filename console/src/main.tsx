import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

createRoot(document.getElementById("root")!).render(<App />);
