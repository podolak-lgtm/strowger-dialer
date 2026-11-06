import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_SECTIONS, TAB_ALIASES, tabOfPath, visibleNav, visibleTabs, type NavViewer } from "./nav";

const client = (roles: NavViewer["roles"]): NavViewer => ({ roles, bare: false, platformTenant: false, acting: false });

test("a client admin gets three launchers and seven items", () => {
  const nav = visibleNav(client(["ADMIN"]));
  assert.deepEqual(nav.launchers.map((l) => l.href), ["/agent", "/floor", "/campaigns"]);
  assert.deepEqual(nav.items.map((i) => i.label), ["Dashboard", "Leads", "Numbers", "Compliance", "People", "Billing", "Settings"]);
});

test("the owner inside a client also sees Platform; the bare platform keeps its short list", () => {
  const acting = visibleNav({ roles: ["ADMIN"], bare: false, platformTenant: false, acting: true });
  assert.ok(acting.items.some((i) => i.href === "/platform"));
  const bare = visibleNav({ roles: ["ADMIN"], bare: true, platformTenant: true, acting: false });
  assert.deepEqual(bare.launchers, []);
  assert.deepEqual(bare.items.map((i) => i.href), ["/platform", "/people", "/settings"]);
});

test("an agent sees the console, and single-tab sections take the tab's name", () => {
  const nav = visibleNav(client(["AGENT"]));
  assert.deepEqual(nav.launchers.map((l) => l.key), ["agent"]);
  assert.deepEqual(nav.items.map((i) => [i.label, i.href]), [["Dashboard", "/dashboard"], ["Voicemails", "/voicemails"], ["Games", "/games"]]);
});

test("roles keep what they had before the regrouping", () => {
  const tl = visibleNav(client(["TEAM_LEADER"]));
  assert.deepEqual(tl.launchers.map((l) => l.key), ["agent", "floor"]);
  assert.deepEqual(visibleTabs(client(["TEAM_LEADER"]), "leads").map((t) => t.href), ["/leads"]);
  assert.deepEqual(visibleTabs(client(["ROOM_SUPERVISOR"]), "dashboard").map((t) => t.href), ["/dashboard", "/reports", "/reports/inbound"]);
  const sup = visibleNav(client(["SUPERVISOR"]));
  assert.ok(!sup.items.some((i) => i.href === "/settings"), "settings stays admin-only");
  assert.ok(sup.items.some((i) => i.href === "/billing"));
  // Refer & earn (6 Nov) is a tab under Billing for admins and supervisors only.
  assert.deepEqual(sup.items.find((i) => i.key === "billing")?.tabs.map((t) => t.href), ["/billing", "/refer"]);
  assert.ok(!visibleNav(client(["TEAM_LEADER"])).items.some((i) => i.key === "billing"));
  assert.deepEqual(visibleNav(client(["AFFILIATE"])).items.map((i) => i.href), ["/dashboard", "/partner"]);
});

test("every old page is still a tab, and sub-pages map to their tab", () => {
  const hrefs = NAV_SECTIONS.flatMap((s) => s.tabs.map((t) => t.href));
  for (const old of ["/dashboard", "/reports", "/leads", "/lists", "/cadences", "/affiliates", "/numbers", "/dids", "/inbound", "/voicemails", "/compliance", "/people", "/teams", "/games"]) {
    assert.ok(hrefs.includes(old), old);
  }
  const tabs = visibleTabs(client(["ADMIN"]), "numbers");
  assert.equal(tabOfPath(tabs, "/skills"), "inbound");
  assert.equal(tabOfPath(tabs, "/dids"), "reputation");
  assert.equal(tabOfPath(visibleTabs(client(["ADMIN"]), "leads"), "/lists/abc"), "lists");
  assert.equal(tabOfPath(tabs, "/numbersx"), null);
  // The Inbound report is its own tab under Dashboard: the longer URL wins over Reports.
  const dash = visibleTabs(client(["SUPERVISOR"]), "dashboard");
  assert.equal(tabOfPath(dash, "/reports/inbound"), "inbound-report");
  assert.equal(tabOfPath(dash, "/reports"), "reports");
});

test("?tab= on a section root points at the tab's page", () => {
  assert.ok(TAB_ALIASES.some((a) => a.source === "/numbers" && a.tab === "reputation" && a.destination === "/dids"));
  assert.ok(TAB_ALIASES.some((a) => a.source === "/leads" && a.tab === "lists" && a.destination === "/lists"));
  assert.ok(!TAB_ALIASES.some((a) => a.source === a.destination));
});
