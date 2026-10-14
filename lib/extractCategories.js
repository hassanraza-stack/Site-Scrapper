/**
 * Extract past-paper category links from TestPoint listing HTML
 * (.category-div table → a[href*="/paper-mcqs/"]).
 */

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{ title: string, url: string, externalId: number|null, slug: string, sortOrder: number }>>}
 */
async function extractCategoriesFromPage(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const results = [];

    const links = document.querySelectorAll(
      '.category-div table a[href*="/paper-mcqs/"], table.section-hide-show a[href*="/paper-mcqs/"], a[href*="/paper-mcqs/"]'
    );

    links.forEach((a, index) => {
      const href = a.href || a.getAttribute("href") || "";
      if (!href || !href.includes("/paper-mcqs/")) return;

      let url;
      try {
        url = new URL(href, window.location.origin).toString();
      } catch {
        return;
      }

      // Normalize: strip query/hash and trailing slash
      try {
        const u = new URL(url);
        u.search = "";
        u.hash = "";
        u.pathname = u.pathname.replace(/\/$/, "");
        url = u.toString();
      } catch {
        /* keep url */
      }

      if (seen.has(url)) return;
      seen.add(url);

      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) return;

      const m = url.match(/\/paper-mcqs\/(\d+)\/([^/?#]+)/i);
      const externalId = m ? parseInt(m[1], 10) : null;
      const slug = m
        ? decodeURIComponent(m[2])
        : decodeURIComponent(url.split("/").filter(Boolean).pop() || `cat-${index + 1}`);

      results.push({
        title,
        url,
        externalId: Number.isFinite(externalId) ? externalId : null,
        slug,
        sortOrder: results.length + 1,
      });
    });

    return results;
  });
}

module.exports = { extractCategoriesFromPage };
