const { launchBrowser, gotoListingPage } = require("./browser");
const { extractMcqsFromPage } = require("./extractMcqs");
const {
  normalizeBaseUrl,
  detectMaxPage,
  pageUrl,
} = require("./pagination");
const {
  upsertSection,
  setSectionMaxPage,
  ensurePageJobs,
  resetStuckRunningJobs,
  getPendingPages,
  markPageRunning,
  markPageDone,
  markPageFailed,
  upsertMcq,
} = require("./db");
const { crawlDelayMs, maxPageRetries } = require("./env");

function resolveSectionInput(input, sectionsFromConfig) {
  if (!input) return null;
  const trimmed = input.trim();

  if (trimmed.startsWith("http")) {
    const norm = normalizeBaseUrl(trimmed);
    const match = sectionsFromConfig.find(
      (s) => normalizeBaseUrl(s.url) === norm
    );
    if (match) return match;
    const u = new URL(trimmed);
    const slug = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop());
    const bySlug = sectionsFromConfig.find((s) => s.slug === slug);
    if (bySlug) return bySlug;
    return {
      kind: u.pathname.includes("past-papers") ? "past_paper" : "important",
      title: slug,
      slug,
      url: norm,
    };
  }

  const slug = trimmed.replace(/^\//, "");
  return sectionsFromConfig.find((s) => s.slug === slug) || null;
}

async function crawlSection(sectionMeta, options = {}) {
  const maxPagesLimit = options.maxPages;
  const onPage = options.onPage || (() => {});

  const baseUrl = normalizeBaseUrl(sectionMeta.url);
  const sectionId = await upsertSection(sectionMeta);
  await resetStuckRunningJobs(sectionId);

  const { browser, context } = await launchBrowser(options.browserOptions);
  const page = await context.newPage();

  let detectedMax = 1;
  try {
    await gotoListingPage(page, baseUrl);
    detectedMax = await detectMaxPage(page);
    // Always remember the real site size (never shrink for --max-pages tests)
    await setSectionMaxPage(sectionId, detectedMax);
    await ensurePageJobs(sectionId, detectedMax);
  } finally {
    await browser.close();
  }

  const pending = await getPendingPages(sectionId);
  const pagesToRun =
    maxPagesLimit != null
      ? pending.filter((p) => p.page_num <= maxPagesLimit)
      : pending;

  const nav =
    options.navProgress &&
    `[${options.navProgress.index}/${options.navProgress.total}] `;

  if (pagesToRun.length === 0) {
    console.log(
      `${nav || ""}[${sectionMeta.slug}] already complete (${detectedMax} pages) — next nav item`
    );
    return {
      sectionId,
      maxPage: detectedMax,
      totalMcqs: 0,
      newMcqs: 0,
      linkedOnly: 0,
      skipped: true,
    };
  }

  console.log(
    `${nav || ""}[${sectionMeta.slug}] site pages=${detectedMax}, still to crawl=${pagesToRun.length}`
  );

  const { browser: b2, context: c2 } = await launchBrowser(options.browserOptions);
  const page2 = await c2.newPage();

  let totalMcqs = 0;
  let newMcqs = 0;
  let linkedOnly = 0;

  try {
    for (const job of pagesToRun) {
      const url = pageUrl(baseUrl, job.page_num);
      await markPageRunning(sectionId, job.page_num);

      try {
        await gotoListingPage(page2, url);
        const mcqs = await extractMcqsFromPage(page2);

        let pageNew = 0;
        let pageLinked = 0;
        for (const mcq of mcqs) {
          const result = await upsertMcq(mcq, sectionId);
          if (result.isNew) {
            pageNew += 1;
            newMcqs += 1;
          } else if (result.sectionLinked) {
            pageLinked += 1;
            linkedOnly += 1;
          }
        }

        totalMcqs += mcqs.length;
        await markPageDone(sectionId, job.page_num);
        onPage({
          section: sectionMeta.slug,
          pageNum: job.page_num,
          maxPage: detectedMax,
          mcqCount: mcqs.length,
          newMcqs: pageNew,
          linkedOnly: pageLinked,
        });
        console.log(
          `[${sectionMeta.slug}] page ${job.page_num}/${detectedMax} — ` +
            `${mcqs.length} on page (${pageNew} new, ${pageLinked} already known → linked this section)`
        );
      } catch (err) {
        const msg = err.message || String(err);
        await markPageFailed(sectionId, job.page_num, msg);
        console.error(
          `[${sectionMeta.slug}] page ${job.page_num} failed (attempt ${job.attempts + 1}/${maxPageRetries()}): ${msg}`
        );
      }

      await page2.waitForTimeout(crawlDelayMs());
    }
  } finally {
    await b2.close();
  }

  return {
    sectionId,
    maxPage: detectedMax,
    totalMcqs,
    newMcqs,
    linkedOnly,
    skipped: false,
  };
}

module.exports = { crawlSection, resolveSectionInput };
