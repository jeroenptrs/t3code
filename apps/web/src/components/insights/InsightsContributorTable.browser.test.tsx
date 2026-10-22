import { InsightsContributorId, type InsightsContributorRow } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { InsightsContributorTable } from "./InsightsContributorTable";

const row = (name: string, landedHours: number, pushedHours: number): InsightsContributorRow => ({
  contributorId: InsightsContributorId.make(name),
  displayName: name,
  kind: "human",
  pushedHours,
  landedHours,
  landedShare: pushedHours === 0 ? null : landedHours / pushedHours,
  throughput: pushedHours / 40,
  commits: 1,
  mergeRequestsMerged: 0,
  reviewsGiven: 0,
  medianFirstReviewHours: null,
  medianCycleHours: null,
});

const ROWS = [row("Ada", 12, 20), row("Bea", 30, 31), row("Cy", 5, 40)];

const names = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr")).map(
    (tableRow) => tableRow.querySelector("td")?.textContent,
  );

it("sorts by landed hours first, then by the column a reader clicks", async () => {
  await using screen = await render(<InsightsContributorTable rows={ROWS} />);
  await expect
    .element(screen.getByRole("columnheader", { name: "Landed", exact: true }))
    .toHaveAttribute("aria-sort", "descending");
  expect(names(screen.container)).toEqual(["Bea", "Ada", "Cy"]);

  await userEvent.click(page.getByRole("button", { name: "Pushed", exact: true }));
  await expect
    .element(screen.getByRole("columnheader", { name: "Pushed", exact: true }))
    .toHaveAttribute("aria-sort", "descending");
  expect(names(screen.container)).toEqual(["Cy", "Bea", "Ada"]);

  await userEvent.click(page.getByRole("button", { name: "Pushed", exact: true }));
  await expect
    .element(screen.getByRole("columnheader", { name: "Pushed", exact: true }))
    .toHaveAttribute("aria-sort", "ascending");
  expect(names(screen.container)).toEqual(["Ada", "Bea", "Cy"]);
});
