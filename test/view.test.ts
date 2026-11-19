import { describe, expect, it } from "vitest";
import { Graph } from "../src/graph/graph.js";
import type { GraphNode } from "../src/graph/types.js";
import { view } from "../src/query/view.js";

const file = (name: string): GraphNode => ({ id: `file:${name}`, kind: "file", name, file: name, line: null, detail: "typescript" });

describe("view", () => {
  it("cannot be broken out of by a file name", () => {
    const hostile = file('a</script><script>alert(1)</script><!--" .ts');
    const graph = new Graph([hostile, file("b.ts")], [{ src: "file:b.ts", dst: hostile.id, kind: "imports", line: 1 }]);
    const { html } = view(graph, { title: '<img src=x onerror="alert(1)">', focus: hostile });

    // Exactly the two script elements the page is written with, and no raw markup from the data.
    expect(html.match(/<script>/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(" ");

    const embedded = /window\.ATLAS = (.*);<\/script>/.exec(html)?.[1] ?? "";
    const data = JSON.parse(embedded) as { nodes: string[][]; focus: string };
    expect(data.nodes[0]?.[2]).toBe(hostile.name);
    expect(data.focus).toBe(hostile.id);
  });

  it("is one file that loads nothing from the network", () => {
    const graph = new Graph([file("a.ts"), file("b.ts")], [{ src: "file:a.ts", dst: "file:b.ts", kind: "imports", line: 1 }]);
    const result = view(graph, { title: "shop" });
    expect(result).toMatchObject({ nodes: 2, edges: 1 });
    expect(result.html).not.toMatch(/\b(?:src|href)\s*=|@import|url\(\s*["']?https?:|fetch\(|XMLHttpRequest/);
    expect(result.html).toContain("<title>shop · repo-atlas</title>");
  });
});
