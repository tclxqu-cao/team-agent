import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import groovy from "highlight.js/lib/languages/groovy";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import properties from "highlight.js/lib/languages/properties";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { codePreviewLanguage, MAX_HIGHLIGHT_CHARACTERS, MAX_HIGHLIGHT_LINE_LENGTH } from "./codePreviewLanguage";

for (const [name, grammar] of Object.entries({
  bash, c, cpp, css, dockerfile, go, graphql, groovy, ini, java, javascript,
  json, kotlin, markdown, properties, protobuf, python, ruby, rust, scss,
  sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, grammar);
}

// Only the highlighter's escaped markup reaches the preview, never raw file HTML.
export function highlightCode(path: string, source: string): string | null {
  const language = codePreviewLanguage(path);
  if (!language || source.length > MAX_HIGHLIGHT_CHARACTERS) return null;
  if (source.split("\n").some((line) => line.length > MAX_HIGHLIGHT_LINE_LENGTH)) return null;
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
