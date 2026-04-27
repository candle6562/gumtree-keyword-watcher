import { describe, expect, it } from "vitest";
import { parseGumtreeResults } from "../src/gumtree.js";

describe("parseGumtreeResults", () => {
  it("extracts unique listing urls and titles", () => {
    const html = `
      <html><body>
        <a href="/p/lawnmowers/greenworks-40v/123" title="Greenworks 40V Lawnmower">Listing 1</a>
        <a href="/p/lawnmowers/greenworks-40v/123" title="Greenworks 40V Lawnmower">Duplicate</a>
        <a href="https://www.gumtree.com/p/lawnmowers/bosch-rotak/456"><h2>Bosch Rotak Lawnmower</h2></a>
      </body></html>
    `;

    const listings = parseGumtreeResults(html);

    expect(listings).toEqual([
      {
        title: "Greenworks 40V Lawnmower",
        url: "https://www.gumtree.com/p/lawnmowers/greenworks-40v/123"
      },
      {
        title: "Bosch Rotak Lawnmower",
        url: "https://www.gumtree.com/p/lawnmowers/bosch-rotak/456"
      }
    ]);
  });
});
