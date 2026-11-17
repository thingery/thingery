// The web chat shows item cards for the listings a reply talks about. Those ids come from the
// turn's own tool results (never the model's prose) and are picked by what the reply mentions.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/items.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/items.js")>();
  return { ...actual, searchItems: vi.fn() };
});
import { searchItems } from "../src/items.js";
import { chatTurn, MAX_REPLY_ITEMS, replyItemIds, turnItemsFromToolResult } from "../src/chat.js";

const ADIDAS = { id: "8962951d-412d-4983-8fe1-a56d10109350", title: "Sapatilhas Trainers Adidas" };
const NIKE = { id: "a1f38ed7-8247-420a-a0cd-0b1498286ab7", title: "Nike Air Max 90" };
const LAMP = { id: "ed76d927-6702-4980-892d-0c1dff747527", title: "Lamp" };

describe("replyItemIds", () => {
  it("takes listings the reply links, whatever link shape the model wrote", () => {
    const text = `See [this one](https://thingery/items/${NIKE.id}) and /item/adidas-${ADIDAS.id}`;
    expect(replyItemIds(text, [ADIDAS, NIKE])).toEqual([NIKE.id, ADIDAS.id]);
  });

  it("takes listings the reply names, even with a shortened title", () => {
    const text = "**Nike Air Max 90** — €85\n**Adidas Trainers** — €30";
    expect(replyItemIds(text, [ADIDAS, NIKE, LAMP])).toEqual([NIKE.id, ADIDAS.id]);
  });

  it("needs two title words, or the whole title when it has one", () => {
    expect(replyItemIds("Adidas makes good shoes.", [ADIDAS])).toEqual([]);
    expect(replyItemIds("A lamp for your desk.", [LAMP])).toEqual([LAMP.id]);
  });

  it("shows nothing a reply doesn't mention, even when it was searched", () => {
    expect(replyItemIds("Nothing here fits your size, sorry.", [ADIDAS, NIKE])).toEqual([]);
  });

  it("lists a listing once and keeps at most three", () => {
    const many = Array.from({ length: 5 }, (_, n) => ({
      id: `0000000${n}-1111-4111-8111-111111111111`,
      title: `Camera model ${n}`,
    }));
    const text = many.map((item) => `/item/${item.id}`).join(" ");
    expect(replyItemIds(text, [...many, ...many])).toHaveLength(MAX_REPLY_ITEMS);
  });
});

describe("turnItemsFromToolResult", () => {
  it("reads search results, a fetched item and a new listing", () => {
    expect(turnItemsFromToolResult("search_items", {}, { results: [ADIDAS, NIKE] })).toEqual([
      ADIDAS,
      NIKE,
    ]);
    expect(turnItemsFromToolResult("get_item", {}, { item: ADIDAS })).toEqual([ADIDAS]);
    expect(
      turnItemsFromToolResult("create_listing", { title: "Road bike" }, { created: true, id: LAMP.id }),
    ).toEqual([{ id: LAMP.id, title: "Road bike" }]);
  });

  it("reads nothing from errors or other tools", () => {
    expect(turnItemsFromToolResult("get_item", {}, { error: "not found" })).toEqual([]);
    expect(turnItemsFromToolResult("my_orders", {}, { results: [ADIDAS] })).toEqual([]);
    expect(turnItemsFromToolResult("create_listing", {}, { error: "unknown category" })).toEqual([]);
  });
});

describe("chatTurn items", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(searchItems).mockReset();
  });

  function scriptLlm(script: unknown[]) {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const step = Math.min(calls++, script.length - 1);
        return new Response(JSON.stringify({ choices: [{ message: script[step] }] }), { status: 200 });
      }),
    );
  }

  const searchCall = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "search_items", arguments: '{"q":"sapatilhas"}' } }],
  };

  it("returns the searched listings the reply talks about", async () => {
    vi.mocked(searchItems).mockResolvedValue([ADIDAS, NIKE, LAMP] as never);
    scriptLlm([searchCall, { role: "assistant", content: "**Adidas Trainers** — €30, free shipping." }]);

    const out = await chatTurn([], "sapatilhas", null);

    expect(out.items).toEqual([ADIDAS.id]);
  });

  it("returns no items key when the reply mentions none", async () => {
    vi.mocked(searchItems).mockResolvedValue([ADIDAS] as never);
    scriptLlm([searchCall, { role: "assistant", content: "Nothing fits, sorry." }]);

    const out = await chatTurn([], "sapatilhas", null);

    expect(out).not.toHaveProperty("items");
  });

  it("never returns an id the model wrote that no tool returned", async () => {
    vi.mocked(searchItems).mockResolvedValue([] as never);
    scriptLlm([searchCall, { role: "assistant", content: `Try /item/${NIKE.id}` }]);

    const out = await chatTurn([], "sapatilhas", null);

    expect(out).not.toHaveProperty("items");
  });
});
