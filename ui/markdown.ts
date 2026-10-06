import { escapeHtml as escape } from "../src/api/text.ts";

/**
 * A small Markdown renderer for the agent's answers: fenced and inline code, bold, italics, links, headings, lists
 * and paragraphs. The text is escaped first, so only these constructs become HTML.
 */
export function markdown(source: string): string {
	const blocks: string[] = [];
	const fenced = source.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang: string, code: string) => {
		blocks.push(`<pre><code>${escape(code.replace(/\n$/, ""))}</code></pre>`);
		return `\u0000${blocks.length - 1}\u0000`;
	});
	const html = fenced
		.split(/\n{2,}/)
		.map((chunk) => block(chunk.trim()))
		.join("");
	return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!);
}

const LIST_ITEM: RegExp = /^\s*([-*]|\d+\.)\s+/;

/** A blank-line separated chunk: runs of list items become lists, a heading line a heading, the rest paragraphs. */
function block(chunk: string): string {
	if (!chunk) return "";
	if (/^\u0000\d+\u0000$/.test(chunk)) return chunk;
	const out: string[] = [];
	let paragraph: string[] = [];
	let list: string[] = [];
	let ordered = false;
	const flushParagraph = () => {
		if (paragraph.length) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (list.length) out.push(`<${ordered ? "ol" : "ul"}>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
		list = [];
	};
	for (const line of chunk.split("\n")) {
		const heading = /^#{1,4}\s+(.*)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			out.push(`<h4>${inline(heading[1]!)}</h4>`);
		} else if (LIST_ITEM.test(line)) {
			flushParagraph();
			if (!list.length) ordered = /^\s*\d+\./.test(line);
			list.push(line.replace(LIST_ITEM, ""));
		} else if (list.length && /^\s{2,}\S/.test(line)) {
			list[list.length - 1] += ` ${line.trim()}`;
		} else {
			flushList();
			paragraph.push(line);
		}
	}
	flushParagraph();
	flushList();
	return out.join("");
}

function inline(text: string): string {
	return escape(text)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
