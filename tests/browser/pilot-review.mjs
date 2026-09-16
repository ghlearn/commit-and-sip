// Playwright MCP browser_run_code_unsafe file: navigate to the isolated fixture's pilot URL first.
async (page) => {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  await page.waitForLoadState("networkidle");
  await page.locator("#primary-action").filter({ hasText: "Start real GitHub pilot" }).waitFor();
  expect((await page.locator("#mode-label").textContent()).includes("UNRANKED PILOT"), "Pilot label missing");
  expect((await page.locator("#mode-description").textContent()).includes("Not native App tracking"), "Provenance missing");
  expect(!(await page.locator("#scoring-note").textContent()).includes("1,000"), "Pilot must not promise points");
  await page.getByText("Read the step guide", { exact: true }).click();
  expect((await page.locator("#exercise-sections").textContent()).includes("Submit your own"), "Pilot guide missing");
  await page.locator("#primary-action").click();
  await page.locator("#review-surfaces").waitFor({ state: "visible" });
  expect((await page.locator("#issue-title").textContent()).includes("MOCKED TRANSPORT FIXTURE"), "Fixture must be honestly labeled");
  expect(await page.locator("#primary-action").isDisabled(), "Approval must initially be locked");
  expect(await page.locator("#check-order-action").isDisabled(), "Checkpoint must initially be locked");
  expect(await page.locator("#sync-review-action").isHidden(), "Pilot must not imply native synchronization");
  for (const surface of ["summary", "changes", "checks"]) {
    expect(await page.locator(`#${surface}-content`).isHidden(), `${surface} must require inspection`);
    await page.locator(`[data-surface="${surface}"]`).click();
    await page.locator(`#${surface}-content`).waitFor({ state: "visible" });
  }
  expect((await page.locator("#review-summary").textContent()).includes("MOCKED TRANSPORT"), "Actual adapter summary missing");
  expect((await page.locator("#changes-content pre").textContent()).includes('"price": 5.5'), "Actual adapter diff missing");
  expect((await page.locator("#checks-content").textContent()).includes("github-actions"), "Check publisher missing");
  await page.reload();
  await page.waitForLoadState("networkidle");
  expect((await page.locator("#view-count").textContent()).trim() === "3 / 3", "Resume lost review progress");
  expect(await page.locator("#check-price").inputValue() === "", "Checkpoint answers must not be prefilled");
  await page.locator("#check-price").fill("5");
  await page.locator("#check-serving").selectOption("hot");
  await page.locator("#check-scope").selectOption("one-drink");
  await page.locator("#check-order-action").click();
  await page.locator("#status").filter({ hasText: "price should be $5.50" }).waitFor();
  expect(await page.locator("#primary-action").isDisabled(), "Wrong answer unlocked approval");
  expect(await page.locator("#review-feedback-link").isVisible(), "Correction route missing");
  await page.locator("#check-price").fill("5.50");
  await page.locator("#check-order-action").click();
  await page.waitForFunction(() => !document.getElementById("primary-action").disabled);
  await page.locator("#primary-action").click();
  await page.locator("#app-result-status").filter({ hasText: "Approved — waiting for an authorized merge" }).waitFor();
  expect(!(await page.locator("#menu").textContent()).includes("Your assigned order"), "Approval must not serve");
  await page.locator("#primary-action").click();
  await page.locator("#error-message").filter({ hasText: "Approval is not a merge" }).waitFor();
  expect((await page.locator("#view-count").textContent()).trim() === "0 / 3", "Failed verification must clear observations");
  expect(await page.locator("#result").isHidden(), "Pending merge must not display a ranked result");
  return { browser: "real renderer", transport: "mocked only", approvedButNotMerged: true, checkpointAndRecovery: "passed" };
}
