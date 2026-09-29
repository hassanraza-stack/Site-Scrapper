const crypto = require("crypto");

/** In-browser extraction — finds blocks by ol[type="A"]. */
const EXTRACT_SCRIPT = () => {
  function hashFallback(text) {
    let h = 0;
    const s = (text || "").trim();
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return "hash_" + Math.abs(h);
  }

  function findBlock(ol) {
    let block = ol.parentElement;
    while (block && block !== document.body) {
      if (
        block.querySelector('a.theme-color[href*="/mcqs/"]') ||
        block.querySelector("h5") ||
        block.querySelector(".question-explanation")
      ) {
        return block;
      }
      block = block.parentElement;
    }
    return ol.parentElement;
  }

  function getQuestionEn(block) {
    const link = block.querySelector(
      'a.theme-color.font-weight-bold[href*="/mcqs/"]'
    );
    if (link) {
      return {
        text: (link.textContent || "").trim(),
        url: link.href,
        id: (link.href.match(/\/mcqs\/(\d+)\//) || [])[1] || null,
      };
    }
    const h5 = block.querySelector("h5");
    if (h5) {
      const text = (h5.textContent || "").trim();
      return { text, url: null, id: null };
    }
    return { text: "", url: null, id: null };
  }

  const seen = new Set();
  const results = [];
  const ols = document.querySelectorAll('ol[type="A"]');

  ols.forEach((ol, index) => {
    const block = findBlock(ol);
    const { text: questionEn, url: questionUrl, id: urlId } =
      getQuestionEn(block);

    const optionEls = ol.querySelectorAll(":scope > li");
    if (optionEls.length === 0) return;

    const options = Array.from(optionEls).map((li, i) => ({
      label: String.fromCharCode(65 + i),
      text: (li.textContent || "").trim(),
      isCorrect: li.classList.contains("correct"),
    }));

    const correct = options.find((o) => o.isCorrect);
    const urduEl = block.querySelector("h6.theme-color.text-right");
    const questionUr = urduEl ? urduEl.textContent.trim() : null;

    const explanationEl = block.querySelector(".question-explanation");
    let explanation = null;
    if (explanationEl) {
      const clone = explanationEl.cloneNode(true);
      const heading = clone.querySelector("h6");
      if (heading) heading.remove();
      explanation = (clone.innerText || "").replace(/\s+/g, " ").trim();
    }

    const id =
      urlId ||
      hashFallback(
        questionEn + "|" + options.map((o) => o.text).join("|")
      );

    const dedupeKey = id + "|" + questionEn.slice(0, 80);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    if (!questionEn && !questionUr && !correct) return;

    results.push({
      id,
      questionEn: questionEn || null,
      questionUr,
      options: options.map((o) => ({ label: o.label, text: o.text })),
      correctAnswer: correct ? correct.text : null,
      correctLabel: correct ? correct.label : null,
      explanation,
      url: questionUrl,
    });
  });

  return results;
};

async function clickShowAnswers(page) {
  const showAnswers = page.locator("text=Show Answers").first();
  if (await showAnswers.isVisible().catch(() => false)) {
    await showAnswers.click();
    await page.waitForTimeout(500);
  }
}

async function extractMcqsFromPage(page) {
  await clickShowAnswers(page);
  return page.evaluate(EXTRACT_SCRIPT);
}

function stableSourceId(mcq) {
  if (mcq.id && !String(mcq.id).startsWith("hash_")) return String(mcq.id);
  const payload =
    (mcq.questionEn || "") +
    "|" +
    (mcq.options || []).map((o) => o.text).join("|");
  return (
    "hash_" +
    crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16)
  );
}

module.exports = {
  extractMcqsFromPage,
  stableSourceId,
};
