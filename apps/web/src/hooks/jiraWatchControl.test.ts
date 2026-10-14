import { describe, expect, it } from "vite-plus/test";

import { jiraWatchControl } from "./jiraWatchControl";

const identities = [{ site: "Acme.atlassian.net" }];
const base = { site: "acme.atlassian.net", watching: false, canOperate: true, identities };

describe("jiraWatchControl", () => {
  it("offers to start only for a site with a server identity, ignoring case", () => {
    expect(jiraWatchControl(base)).toBe("start");
    expect(jiraWatchControl({ ...base, site: "other.atlassian.net" })).toBe("none");
    expect(jiraWatchControl({ ...base, identities: [] })).toBe("none");
  });

  it("offers nothing to start without the operate grant", () => {
    expect(jiraWatchControl({ ...base, canOperate: false })).toBe("none");
  });

  it("lets an operator stop a watch even when the site has no identity", () => {
    expect(jiraWatchControl({ ...base, watching: true, identities: [] })).toBe("stop");
  });

  it("shows an existing watch as an indicator without the operate grant", () => {
    expect(jiraWatchControl({ ...base, watching: true, canOperate: false })).toBe("indicator");
  });
});
