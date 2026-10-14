const {
  launchBrowser,
  closeBrowserSession,
  gotoListingPage,
  isCrashError,
  sleep,
} = require("./browser");
const { extractMcqsFromPage } = require("./extractMcqs");
const { extractCategoriesFromPage } = require("./extractCategories");
const {
  normalizeBaseUrl,
  detectMaxPage,
  pageUrl,
} = require("./pagination");
const {
  upsertSection,
  upsertCategory,
  setCategoryMaxPage,
  ensureCategoryPageJobs,
  resetStuckCategoryJobs,
  getPendingCategoryPages,
  markCategoryPageRunning,
  markCategoryPageDone,
  markCategoryPageFailed,
  getCategoriesForSection,
  upsertMcqAndCategory,
} = require("./db");
const { crawlDelayMs, maxPageRetries } = require("./env");

function browserRestartEvery() {
  return parseInt(process.env.BROWSER_RESTART_EVERY || "15", 10);
}

/**
 * Crawl all /paper-mcqs categories under one past-paper section.
 */
async function crawlPastPaperCategories(sectionMeta, options = {}) {
  try {
    return await crawlPastPaperCategoriesInner(sectionMeta, options);
  } catch (err) {
    console.error(
      `[${sectionMeta.slug}] unexpected category-crawl error:`,
      err.message || err
    );
    return {
      sectionId: null,
      categoriesFound: 0,
      categoriesCrawled: 0,
      totalMcqs: 0,
      newMcqs: 0,
      linkedOnly: 0,
      error: err.message || String(err),
    };
  }
}

async function crawlPastPaperCategoriesInner(sectionMeta, options = {}) {
  const maxPagesLimit = options.maxPages;
  const browserOpts = {
    blockAssets: true,
    ...(options.browserOptions || {}),
  };

  const nav =
    options.navProgress &&
    `[${options.navProgress.index}/${options.navProgress.total}] `;

  const sectionId = await upsertSection(sectionMeta);
  const paperUrl = normalizeBaseUrl(sectionMeta.url);

  console.log(
    `${nav || ""}[${sectionMeta.slug}] discovering categories on past paper...`
  );
  console.log(`  ${paperUrl}`);

  const discovered = await discoverAndUpsertCategories(
    sectionMeta,
    paperUrl,
    sectionId,
    browserOpts
  );

  let categories = await getCategoriesForSection(sectionId);
  if (categories.length === 0) {
    console.warn(
      `[${sectionMeta.slug}] no /paper-mcqs category links found — skipping`
    );
    return {
      sectionId,
      categoriesFound: 0,
      categoriesCrawled: 0,
      totalMcqs: 0,
      newMcqs: 0,
      linkedOnly: 0,
      skipped: true,
    };
  }

  console.log(
    `[${sectionMeta.slug}] ${categories.length} categor(ies) (discovered this pass: ${discovered})`
  );

  let totalMcqs = 0;
  let newMcqs = 0;
  let linkedOnly = 0;
  let categoriesCrawled = 0;

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    console.log(
      `\n  ---- Category ${i + 1}/${categories.length}: ${cat.title} ----`
    );
    console.log(`  ${cat.url}`);

    const result = await crawlOneCategory(cat, sectionId, {
      maxPagesLimit,
      browserOpts,
      sectionSlug: sectionMeta.slug,
    });

    totalMcqs += result.totalMcqs || 0;
    newMcqs += result.newMcqs || 0;
    linkedOnly += result.linkedOnly || 0;
    if (!result.skipped) categoriesCrawled += 1;
  }

  console.log(
    `[${sectionMeta.slug}] categories pass done — ` +
      `${categories.length} cats, ${newMcqs} new MCQs, ${linkedOnly} existing → category-linked`
  );

  return {
    sectionId,
    categoriesFound: categories.length,
    categoriesCrawled,
    totalMcqs,
    newMcqs,
    linkedOnly,
    skipped: false,
  };
}

async function discoverAndUpsertCategories(
  sectionMeta,
  paperUrl,
  sectionId,
  browserOpts
) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await launchBrowser(browserOpts);
    try {
      await gotoListingPage(probe.page, paperUrl);
      const cats = await extractCategoriesFromPage(probe.page);
      let n = 0;
      for (const cat of cats) {
        await upsertCategory({
          sectionId,
          externalId: cat.externalId,
          title: cat.title,
          slug: cat.slug,
          url: normalizeBaseUrl(cat.url),
          sortOrder: cat.sortOrder,
        });
        n += 1;
      }
      return n;
    } catch (err) {
      lastErr = err;
      console.error(
        `[${sectionMeta.slug}] category discovery failed (attempt ${attempt}/3):`,
        err.message
      );
      await sleep(2000 * attempt);
    } finally {
      await closeBrowserSession(probe);
    }
  }
  console.warn(
    `[${sectionMeta.slug}] category discovery failed; using DB categories if any. ${lastErr && lastErr.message}`
  );
  return 0;
}

async function crawlOneCategory(cat, sectionId, options) {
  const { maxPagesLimit, browserOpts, sectionSlug } = options;
  const baseUrl = normalizeBaseUrl(cat.url);
  const categoryId = cat.id;

  await resetStuckCategoryJobs(categoryId);

  let detectedMax = await detectCategoryMaxAndEnqueue(
    cat,
    baseUrl,
    categoryId,
    browserOpts
  );

  let pagesToRun = await loadCategoryPagesToRun(categoryId, maxPagesLimit);

  if (pagesToRun.length === 0) {
    console.log(
      `  [${cat.slug}] already complete (${detectedMax} pages) — next category`
    );
    return {
      totalMcqs: 0,
      newMcqs: 0,
      linkedOnly: 0,
      skipped: true,
      maxPage: detectedMax,
    };
  }

  console.log(
    `  [${cat.slug}] site pages=${detectedMax}, still to crawl=${pagesToRun.length}`
  );

  let session = null;
  let pagesSinceRestart = 0;
  const restartEvery = browserRestartEvery();
  let totalMcqs = 0;
  let newMcqs = 0;
  let linkedOnly = 0;

  async function ensureSession(reason) {
    if (session && session.page && !session.page.isClosed()) {
      try {
        if (session.browser.isConnected()) return;
      } catch {
        /* recreate */
      }
    }
    if (session) {
      console.warn(`  [${cat.slug}] recreating browser (${reason})...`);
      await closeBrowserSession(session);
      await sleep(2000);
    }
    session = await launchBrowser(browserOpts);
    pagesSinceRestart = 0;
  }

  async function recreateBrowser(reason) {
    await closeBrowserSession(session);
    session = null;
    await sleep(2000);
    await ensureSession(reason);
  }

  try {
    await ensureSession("start");

    for (let pass = 1; pass <= 2; pass++) {
      if (pass === 2) {
        await resetStuckCategoryJobs(categoryId);
        pagesToRun = await loadCategoryPagesToRun(categoryId, maxPagesLimit);
        if (pagesToRun.length === 0) break;
        console.log(
          `  [${cat.slug}] sweep pass ${pass}: ${pagesToRun.length} page(s) left`
        );
        await recreateBrowser("before sweep");
      }

      for (const job of pagesToRun) {
        try {
          await ensureSession("before page");
          if (pagesSinceRestart >= restartEvery) {
            await recreateBrowser(`every ${restartEvery} pages`);
          }

          const url = pageUrl(baseUrl, job.page_num);
          await markCategoryPageRunning(categoryId, job.page_num);

          const maxAttempts = Math.max(2, maxPageRetries());
          let success = false;

          for (let attempt = 1; attempt <= maxAttempts && !success; attempt++) {
            try {
              await ensureSession(`attempt ${attempt}`);
              await gotoListingPage(session.page, url);
              const mcqs = await extractMcqsFromPage(session.page);

              let pageNew = 0;
              let pageLinked = 0;
              for (const mcq of mcqs) {
                const result = await upsertMcqAndCategory(
                  mcq,
                  categoryId,
                  sectionId
                );
                if (result.isNew) {
                  pageNew += 1;
                  newMcqs += 1;
                } else if (result.categoryLinked) {
                  pageLinked += 1;
                  linkedOnly += 1;
                }
              }

              totalMcqs += mcqs.length;
              await markCategoryPageDone(categoryId, job.page_num);
              pagesSinceRestart += 1;
              success = true;

              console.log(
                `  [${cat.slug}] page ${job.page_num}/${detectedMax} — ` +
                  `${mcqs.length} on page (${pageNew} new, ${pageLinked} linked to category)`
              );
            } catch (err) {
              const msg = err.message || String(err);
              console.error(
                `  [${cat.slug}] page ${job.page_num} failed (attempt ${attempt}/${maxAttempts}): ${msg}`
              );
              if (isCrashError(err) || (session && session.page.isClosed())) {
                await recreateBrowser("page crashed");
              }
              if (attempt >= maxAttempts) {
                await markCategoryPageFailed(categoryId, job.page_num, msg).catch(
                  () => {}
                );
              } else {
                await sleep(1500 * attempt);
              }
            }
          }
        } catch (jobErr) {
          const msg = jobErr.message || String(jobErr);
          console.error(
            `  [${cat.slug}] page ${job.page_num} unexpected: ${msg} — continuing`
          );
          await markCategoryPageFailed(categoryId, job.page_num, msg).catch(
            () => {}
          );
          await recreateBrowser("unexpected job error").catch(() => {});
        }

        await sleep(crawlDelayMs());
      }
    }
  } finally {
    await closeBrowserSession(session);
  }

  const leftover = await loadCategoryPagesToRun(categoryId, maxPagesLimit);
  if (leftover.length > 0) {
    console.warn(
      `  [${cat.slug}] WARNING: ${leftover.length} page(s) still not done ` +
        `(parent: ${sectionSlug})`
    );
  } else {
    console.log(`  [${cat.slug}] category complete ✓`);
  }

  return {
    totalMcqs,
    newMcqs,
    linkedOnly,
    skipped: false,
    maxPage: detectedMax,
    leftoverPages: leftover.length,
  };
}

async function detectCategoryMaxAndEnqueue(cat, baseUrl, categoryId, browserOpts) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await launchBrowser(browserOpts);
    try {
      await gotoListingPage(probe.page, baseUrl);
      const detectedMax = await detectMaxPage(probe.page);
      // Pages with no MCQs / no pagination still get page 1
      const maxPage = Math.max(1, detectedMax || 1);
      await setCategoryMaxPage(categoryId, maxPage);
      await ensureCategoryPageJobs(categoryId, maxPage);
      return maxPage;
    } catch (err) {
      lastErr = err;
      console.error(
        `  [${cat.slug}] detect max page failed (attempt ${attempt}/3):`,
        err.message
      );
      await sleep(2000 * attempt);
    } finally {
      await closeBrowserSession(probe);
    }
  }
  const fallback = cat.max_page || 1;
  console.warn(
    `  [${cat.slug}] using fallback max_page=${fallback}: ${lastErr && lastErr.message}`
  );
  await ensureCategoryPageJobs(categoryId, fallback);
  return fallback;
}

async function loadCategoryPagesToRun(categoryId, maxPagesLimit) {
  const pending = await getPendingCategoryPages(categoryId);
  if (maxPagesLimit != null) {
    return pending.filter((p) => p.page_num <= maxPagesLimit);
  }
  return pending;
}

module.exports = { crawlPastPaperCategories };
