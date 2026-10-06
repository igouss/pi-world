import { describe, expect, it } from "vitest";
import { markdown } from "../ui/markdown.ts";

describe("markdown", () => {
	it("renders a bold line followed by list items as a paragraph and a list", () => {
		expect(markdown("**Functions**\n- `a()` adds\n- `b()` removes")).toBe(
			"<p><strong>Functions</strong></p><ul><li><code>a()</code> adds</li><li><code>b()</code> removes</li></ul>",
		);
	});

	it("escapes HTML outside code", () => {
		expect(markdown("<script>x</script>")).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
	});

	it("keeps a fenced block verbatim and escaped", () => {
		expect(markdown("before\n\n```js\nif (a < b) {}\n```\n\nafter")).toBe("<p>before</p><pre><code>if (a &lt; b) {}</code></pre><p>after</p>");
	});

	it("renders an ordered list", () => {
		expect(markdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
	});
});
