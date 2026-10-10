import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./styles.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider defaultColorScheme="auto"><App /></MantineProvider>
  </React.StrictMode>,
);
