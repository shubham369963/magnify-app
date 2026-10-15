import ReactMarkdown, { type Components } from "react-markdown";
import { Box } from "@mui/material";
import { markdownRehypePlugins, markdownRemarkPlugins } from "../../lib/markdown-config.mjs";

const components: Components = {
  a: ({ href, children }) => (
    <Box component="a" href={href} target="_blank" rel="noopener noreferrer" sx={{ color: "primary.main", textDecoration: "underline", textUnderlineOffset: 2 }}>
      {children}
    </Box>
  ),
  blockquote: ({ children }) => (
    <Box component="blockquote" sx={{ m: 0, pl: 1.25, borderLeft: 2, borderColor: "primary.main", color: "text.secondary" }}>
      {children}
    </Box>
  ),
  code: ({ children, className }) => (
    <Box component="code" className={className} sx={{ px: className ? 0 : 0.45, py: className ? 0 : 0.1, borderRadius: 0.5, bgcolor: className ? "transparent" : "action.hover", fontFamily: "monospace", fontSize: "0.92em" }}>
      {children}
    </Box>
  ),
  h1: ({ children }) => <Box component="h3" sx={{ m: 0, fontSize: "1.05rem", lineHeight: 1.35, fontWeight: 700 }}>{children}</Box>,
  h2: ({ children }) => <Box component="h3" sx={{ m: 0, fontSize: "1.05rem", lineHeight: 1.35, fontWeight: 700 }}>{children}</Box>,
  h3: ({ children }) => <Box component="h4" sx={{ m: 0, fontSize: "0.9rem", lineHeight: 1.35, fontWeight: 700 }}>{children}</Box>,
  h4: ({ children }) => <Box component="h4" sx={{ m: 0, fontSize: "0.9rem", lineHeight: 1.35, fontWeight: 700 }}>{children}</Box>,
  h5: ({ children }) => <Box component="h4" sx={{ m: 0, fontSize: "0.9rem", lineHeight: 1.35, fontWeight: 700 }}>{children}</Box>,
  h6: ({ children }) => <Box component="h4" sx={{ m: 0, fontSize: "0.9rem", lineHeight: 1.35, fontWeight: 700 }}>{children}</Box>,
  li: ({ children }) => <Box component="li" sx={{ pl: 0.2, fontSize: "0.8125rem", lineHeight: 1.5 }}>{children}</Box>,
  ol: ({ children }) => <Box component="ol" sx={{ m: 0, pl: 2.5, display: "grid", gap: 0.35 }}>{children}</Box>,
  p: ({ children }) => <Box component="p" sx={{ m: 0, fontSize: "0.8125rem", lineHeight: 1.55 }}>{children}</Box>,
  pre: ({ children }) => <Box component="pre" sx={{ m: 0, p: 1, overflowX: "auto", borderRadius: 1, bgcolor: "action.hover", fontSize: "0.78rem", lineHeight: 1.5 }}>{children}</Box>,
  strong: ({ children }) => <Box component="strong" sx={{ color: "primary.dark", fontWeight: 800 }}>{children}</Box>,
  table: ({ children }) => <Box component="div" sx={{ maxWidth: "100%", overflowX: "auto" }}><Box component="table" sx={{ borderCollapse: "collapse", width: "100%", fontSize: "0.8125rem", "& th, & td": { border: 1, borderColor: "divider", px: 0.8, py: 0.45, textAlign: "left" }, "& th": { fontWeight: 700, bgcolor: "action.hover" } }}>{children}</Box></Box>,
  ul: ({ children }) => <Box component="ul" sx={{ m: 0, pl: 2.5, display: "grid", gap: 0.45, "& > li::marker": { color: "primary.main" } }}>{children}</Box>,
};

export default function MarkdownContent({ content }: { content: string }) {
  return (
    <Box sx={{ minWidth: 0, overflowWrap: "anywhere", display: "grid", gap: 0.9 }}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}