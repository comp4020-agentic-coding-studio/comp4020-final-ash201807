import { describe, expect, it } from "vitest";
import { normalizeSeriesList } from "./persistence.ts";

describe("normalizeSeriesList", () => {
  it("passes a current-shape seriesId-keyed record through unchanged", () => {
    const seriesList = {
      "series-1": {
        seriesId: "series-1",
        games: [],
        gamesWon: { A: 1, B: 0 },
        seriesWinner: null,
        seriesStatus: "active" as const,
      },
    };
    expect(normalizeSeriesList(seriesList)).toEqual(seriesList);
  });

  it("treats missing, null, or non-object input as no series active", () => {
    expect(normalizeSeriesList(undefined)).toEqual({});
    expect(normalizeSeriesList(null)).toEqual({});
    expect(normalizeSeriesList("garbage")).toEqual({});
  });

  it("treats an array as no series active rather than misreading it", () => {
    expect(normalizeSeriesList([])).toEqual({});
  });

  it("detects the pre-Stage-4b single-series shape by its own top-level seriesId/games fields and reads it as no series active", () => {
    // The OLD shape IS a SeriesState itself (not a map of them) — its own
    // top-level keys are literally "seriesId" and "games", which would
    // otherwise be misread as a seriesId-keyed map containing entries named
    // "seriesId" and "games".
    const oldShape = { seriesId: "some-series", games: [{ status: "active" }] };
    expect(normalizeSeriesList(oldShape)).toEqual({});
  });

  it("does not misfire on a current-shape record that merely has a seriesId as one of its keys", () => {
    // A real seriesId-keyed record never has BOTH "seriesId" and "games" as
    // literal top-level keys unless a series happens to be named exactly
    // that — astronomically unlikely given newSeriesId()'s random scheme,
    // and not a case this function needs to disambiguate further.
    const seriesList = {
      abc123: { seriesId: "abc123", games: [], gamesWon: { A: 0, B: 0 }, seriesWinner: null, seriesStatus: "active" as const },
    };
    expect(normalizeSeriesList(seriesList)).toEqual(seriesList);
  });

  it("upgrades a pre-Stage-5 entry (no gamesWon/seriesWinner/seriesStatus) to a safe default, never inventing a score or ending an in-progress series", () => {
    const preStage5 = { "series-1": { seriesId: "series-1", games: [{ status: "active" }] } };
    expect(normalizeSeriesList(preStage5)).toEqual({
      "series-1": {
        seriesId: "series-1",
        games: [{ status: "active" }],
        gamesWon: { A: 0, B: 0 },
        seriesWinner: null,
        seriesStatus: "active",
      },
    });
  });

  it("skips an entry that isn't recognizable as a SeriesState at all, rather than guessing at it", () => {
    const mixed = {
      "series-1": { seriesId: "series-1", games: [], gamesWon: { A: 0, B: 0 }, seriesWinner: null, seriesStatus: "active" as const },
      garbage: "not a series",
    };
    expect(normalizeSeriesList(mixed)).toEqual({
      "series-1": mixed["series-1"],
    });
  });
});
