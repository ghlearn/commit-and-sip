// After pilot-review, staff test tooling sets authorizedMockMerge in the isolated fixture controls file.
async (page) => {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  await page.locator("#primary-action").filter({ hasText: "Verify merged menu" }).click();
  await page.locator("#app-result-status").filter({ hasText: "Served — unranked pilot menu verified" }).waitFor();
  expect((await page.locator("#menu").textContent()).includes("Your assigned order"), "Verified menu missing");
  expect((await page.locator("#served-revision").textContent()).includes("cccccccc"), "Merge revision missing");
  expect((await page.locator("#pilot-learning-summary").textContent()).includes("not native Skills completion"), "Pilot learning boundary missing");
  expect(await page.locator("#primary-action").isDisabled(), "Pilot served must be terminal");
  expect(await page.locator("#result").isHidden(), "Pilot must not expose ranked result");
  expect(await page.locator("#leaderboard-link").isHidden(), "Pilot must not expose leaderboard");
  expect(await page.locator("#leaderboard-qr").isHidden(), "Pilot must not expose QR");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.locator("#app-result-status").filter({ hasText: "Served — unranked pilot menu verified" }).waitFor();
  expect(await page.locator("#primary-action").isDisabled(), "Reload must retain terminal pilot result");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile page overflows viewport");
  expect(await page.locator("#app-result").isVisible(), "Mobile pilot result missing");
  return { browser: "real renderer", transport: "mocked only", verifiedServing: true, ranking: "absent", mobileWidth: 390 };
}
