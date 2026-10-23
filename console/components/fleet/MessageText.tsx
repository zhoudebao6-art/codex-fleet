import { Fragment } from "react";

// Keep message HTML inert: emphasis and code are rendered as React text nodes.
function inline(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : <Fragment key={index}>{part}</Fragment>);
}

export default function MessageText({ text }: { text: string }) {
  const parts = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return <div className="prose-block reading-text">{parts.map((part, index) => part.startsWith("```") ? <pre key={index}><code>{part.replace(/^```[^\n]*\n/, "").replace(/```$/, "").trimEnd()}</code></pre> : <Fragment key={index}>{inline(part)}</Fragment>)}</div>;
}
