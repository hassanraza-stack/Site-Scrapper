const {
  launchBrowser,
  closeBrowserSession,
  gotoListingPage,
  isCrashError,
  sleep,
} = require("./browser");
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

function browserRestartEvery() {
  return parseInt(process.env.BROWSER_RESTART_EVERY || "15", 10);
}

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

/**
 * Crawl one section fully. Never throws for page crashes — recreates browser
 * and continues until all pending pages are done or permanently failed.
 */
async function crawlSection(sectionMeta, options = {}) {
  try {
    return await crawlSectionInner(sectionMeta, options);
  } catch (err) {
    // Last-resort: never abort the nav loop with an uncaught crash
    console.error(
      `[${sectionMeta.slug}] unexpected error (section will not abort remaining jobs permanently):`,
      err.message || err
    );
    return {
      sectionId: null,
      maxPage: 0,
      totalMcqs: 0,
      newMcqs: 0,
      linkedOnly: 0,
      skipped: false,
      error: err.message || String(err),
    };
  }
}

async function crawlSectionInner(sectionMeta, options = {}) {
  const maxPagesLimit = options.maxPages;
  const onPage = options.onPage || (() => {});
  const browserOpts = {
    blockAssets: true,
    ...(options.browserOptions || {}),
  };

  const baseUrl = normalizeBaseUrl(sectionMeta.url);
  const sectionId = await upsertSection(sectionMeta);
  await resetStuckRunningJobs(sectionId);

  const nav =
    options.navProgress &&
    `[${options.navProgress.index}/${options.navProgress.total}] `;

  let detectedMax = await detectAndEnqueueJobs(
    sectionMeta,
    baseUrl,
    sectionId,
    browserOpts
  );

  let pagesToRun = await loadPagesToRun(sectionId, maxPagesLimit);

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

  let session = null;
  let pagesSinceRestart = 0;
  const restartEvery = browserRestartEvery();

  let totalMcqs = 0;
  let newMcqs = 0;
  let linkedOnly = 0;

  async function ensureSession(reason) {
    if (session && session.page && !session.page.isClosed()) {
      try {
        // Touch browser; if dead, recreate
        if (session.browser.isConnected()) return;
      } catch {
        /* recreate below */
      }
    }
    if (session) {
      console.warn(`[${sectionMeta.slug}] recreating browser (${reason})...`);
      await closeBrowserSession(session);
      await sleep(2000);
    } else {
      console.log(`[${sectionMeta.slug}] launching browser...`);
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

    // Pass 1: all currently pending pages. Pass 2: one more sweep of leftovers.
    for (let pass = 1; pass <= 2; pass++) {
      if (pass === 2) {
        await resetStuckRunningJobs(sectionId);
        pagesToRun = await loadPagesToRun(sectionId, maxPagesLimit);
        if (pagesToRun.length === 0) break;
        console.log(
          `[${sectionMeta.slug}] sweep pass ${pass}: ${pagesToRun.length} page(s) still pending/failed`
        );
        await recreateBrowser("before sweep pass");
      }

      for (const job of pagesToRun) {
        try {
          await ensureSession("before page");

          if (pagesSinceRestart >= restartEvery) {
            await recreateBrowser(`every ${restartEvery} pages`);
          }

          const url = pageUrl(baseUrl, job.page_num);
          await markPageRunning(sectionId, job.page_num);

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
              pagesSinceRestart += 1;
              success = true;

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
              console.error(
                `[${sectionMeta.slug}] page ${job.page_num} failed (attempt ${attempt}/${maxAttempts}): ${msg}`
              );

              if (isCrashError(err) || (session && session.page.isClosed())) {
                await recreateBrowser("page crashed");
              }

              if (attempt >= maxAttempts) {
                await markPageFailed(sectionId, job.page_num, msg).catch(
                  () => {}
                );
              } else {
                await sleep(1500 * attempt);
              }
            }
          }
        } catch (jobErr) {
          // Must never break the for-loop — log and continue next page
          const msg = jobErr.message || String(jobErr);
          console.error(
            `[${sectionMeta.slug}] page ${job.page_num} unexpected: ${msg} — continuing`
          );
          await markPageFailed(sectionId, job.page_num, msg).catch(() => {});
          await recreateBrowser("unexpected job error").catch(() => {});
        }

        await sleep(crawlDelayMs());
      }
    }
  } finally {
    await closeBrowserSession(session);
  }

  const leftover = await loadPagesToRun(sectionId, maxPagesLimit);
  if (leftover.length > 0) {
    console.warn(
      `[${sectionMeta.slug}] WARNING: ${leftover.length} page(s) still not done. Resume with:\n` +
        `  npm run crawl:resume -- ${sectionMeta.slug}\n` +
        `  # or: node crawl-section.js ${sectionMeta.slug}`
    );
  } else {
    console.log(`[${sectionMeta.slug}] section complete ✓`);
  }

  return {
    sectionId,
    maxPage: detectedMax,
    totalMcqs,
    newMcqs,
    linkedOnly,
    skipped: false,
    leftoverPages: leftover.length,
  };
}

async function detectAndEnqueueJobs(sectionMeta, baseUrl, sectionId, browserOpts) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const probe = await launchBrowser(browserOpts);
    try {
      await gotoListingPage(probe.page, baseUrl);
      const detectedMax = await detectMaxPage(probe.page);
      await setSectionMaxPage(sectionId, detectedMax);
      await ensurePageJobs(sectionId, detectedMax);
      return detectedMax;
    } catch (err) {
      lastErr = err;
      console.error(
        `[${sectionMeta.slug}] detect max page failed (attempt ${attempt}/3):`,
        err.message
      );
      await sleep(2000 * attempt);
    } finally {
      await closeBrowserSession(probe);
    }
  }
  // Fall back to existing max_page or 1 so we don't abort the whole crawl
  const { getSectionBySlug } = require("./db");
  const row = await getSectionBySlug(sectionMeta.slug);
  const fallback = (row && row.max_page) || 1;
  console.warn(
    `[${sectionMeta.slug}] using fallback max_page=${fallback} after detect errors: ${lastErr && lastErr.message}`
  );
  await ensurePageJobs(sectionId, fallback);
  return fallback;
}

async function loadPagesToRun(sectionId, maxPagesLimit) {
  const pending = await getPendingPages(sectionId);
  if (maxPagesLimit != null) {
    return pending.filter((p) => p.page_num <= maxPagesLimit);
  }
  return pending;
}

module.exports = { crawlSection, resolveSectionInput };
