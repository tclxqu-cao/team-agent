#!/usr/bin/env bun
import { startTui } from "./src/main.tsx";

await startTui(process.argv.slice(2), process.env);
