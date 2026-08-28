import React from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { TUI_THEME } from "../theme.js";

function Inline({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}:${index}`;
        switch (token.type) {
          case "strong":
            return <Text key={key} bold color={TUI_THEME.strong}><Inline tokens={(token as Tokens.Strong).tokens} /></Text>;
          case "em":
            return <Text key={key} italic><Inline tokens={(token as Tokens.Em).tokens} /></Text>;
          case "del":
            return <Text key={key} strikethrough><Inline tokens={(token as Tokens.Del).tokens} /></Text>;
          case "codespan":
            return <Text key={key} color={TUI_THEME.code}>{token.text}</Text>;
          case "link":
            return <Text key={key} color={TUI_THEME.active} underline><Inline tokens={(token as Tokens.Link).tokens} /></Text>;
          case "image":
            return <Text key={key} color={TUI_THEME.muted}>[{token.text || "图片"}]</Text>;
          case "br":
            return <React.Fragment key={key}>{"\n"}</React.Fragment>;
          case "escape":
            return <React.Fragment key={key}>{(token as Tokens.Escape).text}</React.Fragment>;
          case "text": {
            const text = token as Tokens.Text;
            return text.tokens
              ? <Inline key={key} tokens={text.tokens} />
              : <React.Fragment key={key}>{text.text}</React.Fragment>;
          }
          default: {
            const generic = token as Tokens.Generic;
            return generic.tokens
              ? <Inline key={key} tokens={generic.tokens} />
              : <React.Fragment key={key}>{"text" in generic ? String(generic.text) : ""}</React.Fragment>;
          }
        }
      })}
    </>
  );
}

function itemInlineTokens(item: Tokens.ListItem): Token[] {
  return item.tokens.flatMap((token) => {
    if (token.type === "list") return [];
    if (token.type === "text" || token.type === "paragraph") return token.tokens ?? [token];
    return [token];
  });
}

function ListBlock({ token, depth = 0 }: { token: Tokens.List; depth?: number }) {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box flexDirection="column" marginLeft={depth * 2}>
      {token.items.map((item, index) => (
        <Box key={`${index}:${item.raw}`} flexDirection="column">
          <Box>
            <Text color={TUI_THEME.agent}>{token.ordered ? `${start + index}.` : "•"}</Text>
            <Text color={TUI_THEME.text}> <Inline tokens={itemInlineTokens(item)} /></Text>
          </Box>
          {item.tokens.filter((child): child is Tokens.List => child.type === "list").map((child, childIndex) => (
            <ListBlock key={`${childIndex}:${child.raw}`} token={child} depth={depth + 1} />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function TableBlock({ token }: { token: Tokens.Table }) {
  return (
    <Box flexDirection="column">
      <Text color={TUI_THEME.strong} bold>{token.header.map((cell) => cell.text).join("  │  ")}</Text>
      {token.rows.map((row, index) => (
        <Text key={index} color={TUI_THEME.text}>{row.map((cell) => cell.text).join("  │  ")}</Text>
      ))}
    </Box>
  );
}

function Block({ token }: { token: Token }) {
  switch (token.type) {
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      const sectionTitle = paragraph.text.length <= 28 && /[:：]$/.test(paragraph.text.trim());
      return <Text color={sectionTitle ? TUI_THEME.strong : TUI_THEME.text} bold={sectionTitle} wrap="wrap"><Inline tokens={paragraph.tokens} /></Text>;
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      return <Text color={TUI_THEME.strong} bold wrap="wrap"><Inline tokens={heading.tokens} /></Text>;
    }
    case "list":
      return <ListBlock token={token as Tokens.List} />;
    case "blockquote":
      return (
        <Box paddingLeft={1} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderLeftColor={TUI_THEME.faint}>
          <MarkdownBlocks tokens={(token as Tokens.Blockquote).tokens} />
        </Box>
      );
    case "code":
      return <Box paddingLeft={1}><Text color={TUI_THEME.code}>{token.text}</Text></Box>;
    case "table":
      return <TableBlock token={token as Tokens.Table} />;
    case "hr":
      return <Text color={TUI_THEME.faint}>────────</Text>;
    case "html":
      return <Text color={TUI_THEME.muted}>{token.text.replace(/<[^>]*>/g, "")}</Text>;
    case "text":
      return <Text color={TUI_THEME.text}><Inline tokens={token.tokens ?? [token]} /></Text>;
    default:
      return null;
  }
}

function MarkdownBlocks({ tokens }: { tokens: Token[] }) {
  const blocks = tokens.filter((token) => token.type !== "space" && token.type !== "def");
  return (
    <Box flexDirection="column">
      {blocks.map((token, index) => (
        <Box
          key={`${token.type}:${index}:${token.raw.slice(0, 24)}`}
          flexDirection="column"
          marginBottom={index < blocks.length - 1 && (token.type === "paragraph" || token.type === "list" || token.type === "code") ? 1 : 0}
        >
          <Block token={token} />
        </Box>
      ))}
    </Box>
  );
}

export function MarkdownText({ children }: { children: string }) {
  return <MarkdownBlocks tokens={marked.lexer(children)} />;
}
