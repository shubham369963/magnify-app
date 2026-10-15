import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export const markdownRemarkPlugins = [remarkGfm, remarkMath];
export const markdownRehypePlugins = [rehypeSanitize, rehypeKatex];