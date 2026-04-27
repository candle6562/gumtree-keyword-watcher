import { describe, expect, it } from "vitest";
import { matchListings } from "../src/matcher.js";

describe("matchListings", () => {
  it("returns listings matching keyword (case-insensitive)", () => {
    const matched = matchListings(
      [
        { title: "Bosch Lawnmower", url: "https://example.com/1" },
        { title: "Cordless Drill", url: "https://example.com/2" }
      ],
      "lawnmower"
    );

    expect(matched).toEqual([
      {
        title: "Bosch Lawnmower",
        url: "https://example.com/1",
        matchedKeyword: "lawnmower"
      }
    ]);
  });
});
